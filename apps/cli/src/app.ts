import { join } from "node:path";
import { Command, CommanderError } from "commander";
import { askSystem } from "@cloud-agent/agent";
import { ConnectionProfile } from "@cloud-agent/contracts";
import { discoverSystem } from "@cloud-agent/discovery";
import { FileAuditLog, FileEvidenceStore, verifyChain } from "@cloud-agent/evidence";
import { FileGraphStore } from "@cloud-agent/graph";
import { parseManifest, reconcileManifest, scopeFromManifest } from "@cloud-agent/manifest";
import type { CliDeps } from "./deps.js";
import { formatAnswer, formatGraph } from "./format.js";
import { CliError, ProfileStore } from "./profiles.js";

const evidenceDir = (
  home: string,
  p: { accountId: string; region: string; systemId: string; environment: string },
) => join(home, "evidence", p.accountId, p.region, p.systemId, p.environment);

function roleAccount(arn: string): string {
  const m = /^arn:aws:iam::(\d{12}):role\//.exec(arn);
  if (!m)
    throw new CliError("--role-arn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)");
  return m[1]!;
}

const collect = (v: string, prev: string[]) => [...prev, v];

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const profiles = new ProfileStore(join(deps.home, "connections.json"));
  const graphs = new FileGraphStore(join(deps.home, "graphs"));
  const audit = new FileAuditLog(join(deps.home, "audit.jsonl"));

  const program = new Command("cloud-agent")
    .description(
      "Understand existing AWS systems with evidence-backed answers (read-only in this version)",
    )
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.out(s.trimEnd()),
      writeErr: (s) => deps.err(s.trimEnd()),
    });

  const refresh = async (p: ConnectionProfile, actor = deps.actor) => {
    const { read: port } = await deps.session(p);
    const evidence = new FileEvidenceStore(evidenceDir(deps.home, p));
    const graph = await discoverSystem(p, port, evidence, { now: deps.now(), graphStore: graphs });
    await profiles.save({ ...p, lastDiscoveryAt: graph.builtAt });
    await audit.append(
      {
        actor,
        action: "discover",
        systemId: p.systemId,
        environment: p.environment,
        target: `${p.accountId}/${p.region}`,
        outcome: "ok",
        detail: {
          resources: graph.resources.length,
          edges: graph.edges.length,
          gaps: graph.gaps.length,
        },
      },
      deps.now(),
    );
    return graph;
  };

  program
    .command("connect")
    .description(
      "Register a scoped, read-only connection to an existing AWS application and run discovery",
    )
    .requiredOption("--region <region>", "AWS region")
    .requiredOption("--role-arn <arn>", "read-only IAM role Cloud Agent will assume")
    .option("--stack <name>", "CloudFormation stack in scope (repeatable)", collect, [] as string[])
    .option("--tag <key=value>", "resource tag in scope (repeatable)", collect, [] as string[])
    .option("--arn <arn>", "explicit resource ARN in scope (repeatable)", collect, [] as string[])
    .option(
      "--manifest <file>",
      "CloudSystemManifest to use as a hint (verified against live discovery)",
    )
    .option("--system <id>", "system id (defaults to the first stack name)")
    .option("--env <name>", "environment name", "default")
    .option("--no-discover", "save the connection without running discovery")
    .action(async (o) => {
      let systemId: string | undefined = o.system;
      let environment: string = o.env;
      let stacks: string[] = o.stack;
      let manifest;
      if (o.manifest) {
        manifest = parseManifest(await deps.readFile(o.manifest));
        const envName = o.env === "default" ? manifest.environments[0]!.name : o.env;
        const hint = scopeFromManifest(manifest, envName);
        if (hint.region !== o.region || hint.accountId !== roleAccount(o.roleArn))
          throw new CliError("manifest account/region does not match --role-arn/--region");
        systemId ??= hint.systemId;
        environment = hint.environment;
        stacks = [...new Set([...stacks, ...hint.scope.stacks])];
      }
      const tags = (o.tag as string[]).map((t) => {
        const [key, ...v] = t.split("=");
        if (!key || !v.length) throw new CliError(`--tag must be key=value, got ${t}`);
        return { key, value: v.join("=") };
      });
      systemId ??= stacks[0];
      if (!systemId) throw new CliError("pass --system, or at least one --stack");
      const profile = ConnectionProfile.parse({
        connectionId: `conn-${systemId}-${environment}`,
        systemId,
        ownerIdentity: deps.actor,
        environment,
        accountId: roleAccount(o.roleArn),
        region: o.region,
        scope: { stacks, resourceArns: o.arn, tags },
        roles: { "read-only": o.roleArn },
      });
      await profiles.save(profile);
      await audit.append(
        {
          actor: deps.actor,
          action: "connect",
          systemId,
          environment,
          target: `${profile.accountId}/${profile.region}`,
          outcome: "ok",
          detail: { scope: profile.scope },
        },
        deps.now(),
      );
      deps.out(
        `Saved read-only connection ${profile.connectionId} (account ${profile.accountId}, ${profile.region}).`,
      );
      if (!o.discover) return;
      const graph = await refresh(profile);
      deps.out(formatGraph(graph, deps.now()));
      if (manifest) {
        const r = reconcileManifest(manifest, environment, graph);
        deps.out(
          `\nManifest reconciliation (live discovery wins): ${r.confirmed.length} confirmed, ${r.missing.length} declared but not found live, ${r.typeMismatches.length} type mismatches, ${r.unexpected.length} live but undeclared.`,
        );
        for (const m of r.missing) deps.out(`  not found live: ${m.logicalId} (${m.type})`);
      }
    });

  const systems = program.command("systems").description("Inspect connected systems");
  systems.command("list").action(async () => {
    const all = await profiles.list();
    if (!all.length) return deps.out("No connections. Run `cloud-agent connect`.");
    for (const p of all)
      deps.out(
        `${p.systemId}  env=${p.environment}  ${p.accountId}/${p.region}  last discovery: ${p.lastDiscoveryAt ?? "never"}`,
      );
  });
  systems
    .command("inspect <system>")
    .option("--env <name>")
    .option("--json", "machine-readable output")
    .action(async (system, o) => {
      const p = await profiles.resolve(system, o.env);
      const g = await graphs.load(p);
      if (!g)
        throw new CliError(
          `no discovery data for ${system}; run \`cloud-agent systems refresh ${system}\``,
        );
      deps.out(o.json ? JSON.stringify(g, null, 2) : formatGraph(g, deps.now()));
    });
  systems
    .command("refresh <system>")
    .option("--env <name>")
    .action(async (system, o) => {
      const g = await refresh(await profiles.resolve(system, o.env));
      deps.out(formatGraph(g, deps.now()));
    });

  program
    .command("ask <question...>")
    .description("Ask an evidence-backed question about a connected system")
    .requiredOption("--system <id>", "system to ask about")
    .option("--env <name>")
    .option("--model <id>", "Bedrock model or inference profile id (or CLOUD_AGENT_MODEL_ID)")
    .option("--json")
    .action(async (words: string[], o) => {
      const p = await profiles.resolve(o.system, o.env);
      const question = words.join(" ");
      const graph = await graphs.load(p);
      const costTag = p.scope.tags[0];
      const session = graph && p.costDataAccess !== undefined ? await deps.session(p) : undefined;
      const answer = await askSystem({
        question,
        graph,
        ...(session?.observe && { observability: session.observe }),
        policy: {
          sensitiveDataAccess: p.sensitiveDataAccess,
          costDataAccess: p.costDataAccess,
          ...(costTag && { costTag }),
        },
        evidence: new FileEvidenceStore(evidenceDir(deps.home, p)),
        model: (await graphs.load(p))
          ? deps.model(o.model, p.region)
          : {
              converse: async () => {
                throw new Error("unreachable");
              },
            },
        now: deps.now(),
      });
      await audit.append(
        {
          actor: deps.actor,
          action: "ask",
          systemId: p.systemId,
          environment: p.environment,
          outcome: "ok",
          detail: { question, evidence: answer.observations.map((x) => x.id) },
        },
        deps.now(),
      );
      deps.out(o.json ? JSON.stringify(answer, null, 2) : formatAnswer(answer));
    });

  program
    .command("audit")
    .description("Show the audit trail and verify its hash chain")
    .option("--system <id>")
    .action(async (o) => {
      const all = await audit.read();
      const v = verifyChain(all);
      for (const r of all.filter((x) => !o.system || x.systemId === o.system))
        deps.out(
          `${r.at}  ${r.actor}  ${r.action}  ${r.systemId}${r.environment ? `/${r.environment}` : ""}  ${r.outcome}`,
        );
      deps.out(
        v.ok
          ? `Audit chain verified (${all.length} records).`
          : `AUDIT CHAIN BROKEN at record ${v.brokenAt}.`,
      );
      if (!v.ok) throw new CliError("audit chain verification failed");
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    deps.err(`error: ${(e as Error).message}`);
    return 1;
  }
}
