import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Command } from "commander";
import { proposePlan } from "@cloud-agent/agent";
import { ChangeService, FileChangeStore } from "@cloud-agent/changes";
import type { ChangeRecord, Verifier } from "@cloud-agent/changes";
import type { ConnectionProfile, SystemGraph } from "@cloud-agent/contracts";
import { FileEvidenceStore } from "@cloud-agent/evidence";
import type { AuditLog } from "@cloud-agent/evidence";
import { fingerprintGraph } from "@cloud-agent/graph";
import { isStackHealthy } from "@cloud-agent/tools-aws";
import { RepoReader } from "@cloud-agent/tools-git";
import { LocalWorkerValidator } from "@cloud-agent/validation";
import type { CliDeps } from "./deps.js";
import { CliError } from "./profiles.js";
import type { ProfileStore } from "./profiles.js";

export interface ChangeCommandContext {
  deps: CliDeps;
  profiles: ProfileStore;
  audit: AuditLog;
  loadGraph(p: ConnectionProfile): Promise<SystemGraph | undefined>;
  refresh(p: ConnectionProfile): Promise<SystemGraph>;
  evidenceDir(p: ConnectionProfile): string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function formatChange(r: ChangeRecord): string {
  const p = r.plan;
  const L = [
    `Change ${p.changeId}  state: ${r.state}  risk: ${p.riskClass}  plan hash: ${p.planHash}`,
    `Target: ${p.systemId}/${p.environment}  account ${p.accountId}  ${p.region}  source revision ${p.sourceRevision}`,
    `Intent: ${p.intent}`,
    r.state === "AWAITING_APPROVAL" || r.state === "DIFF_READY"
      ? "This is a PROPOSAL. Nothing has been applied."
      : "",
    "",
    "Actions:",
    ...p.actions.map((a) => `  - [${a.kind}] ${a.resourceId}: ${a.description}`),
    "",
    "Steps:",
    ...p.steps.map((s, i) => `  ${i + 1}. ${s}`),
  ].filter((x, i) => x !== "" || i > 3);
  if (p.edits.length) L.push("", "Edits:", ...p.edits.map((e) => `  - ${e.path}: ${e.summary}`));
  if (p.risks.length)
    L.push("", "Risks:", ...p.risks.map((x) => `  - (${x.category}) ${x.description}`));
  L.push(
    "",
    `Rollback: ${p.rollback.strategy} (reversible: ${p.rollback.reversible}, backup required: ${p.rollback.requiresBackup})`,
  );
  L.push(
    "",
    "Verification:",
    ...p.verification.map((v) => `  - ${v.id} [${v.kind}] ${v.description}`),
  );
  if (p.artifact)
    L.push("", `Deploys template for stack ${p.artifact.stackName} (sha256 ${p.artifact.sha256})`);
  if (r.validation)
    L.push("", `Validation: ${r.validation.passed ? "passed" : "FAILED"} at ${r.validation.at}`);
  if (r.approval)
    L.push(
      `Approval: ${r.approval.actor}${r.approval.elevated ? " (elevated)" : ""}, expires ${r.approval.expiresAt}${r.approval.invalidatedAt ? `  INVALIDATED: ${r.approval.invalidReason}` : ""}`,
    );
  if (r.execution)
    L.push(
      `Execution: ${r.execution.status} after ${r.execution.attempts} attempt(s): ${r.execution.detail}`,
    );
  if (r.verification)
    L.push(
      `Verification: ${r.verification.passed ? "passed" : "FAILED"}`,
      ...r.verification.checks.map(
        (c) => `  - ${c.id}: ${c.passed ? "ok" : "NOT MET"} ${c.detail}`,
      ),
    );
  return L.join("\n");
}

export function registerChangeCommands(program: Command, c: ChangeCommandContext): void {
  const { deps } = c;
  const service = async (p: ConnectionProfile) =>
    new ChangeService({
      store: new FileChangeStore(
        join(deps.home, "changes", p.accountId, p.region, p.systemId, p.environment),
      ),
      audit: c.audit,
      policy: { writeRoleConfigured: !!p.roles.write },
      now: deps.now,
    });

  const locate = async (changeId: string, system: string, env?: string) => {
    const p = await c.profiles.resolve(system, env);
    return { p, svc: await service(p) };
  };

  program
    .command("plan <intent...>")
    .description("Propose a change to a connected system (read-only; nothing is applied)")
    .requiredOption("--system <id>")
    .option("--env <name>")
    .option("--model <id>")
    .option("--template <file>", "synthesized template that approval will be bound to (sha256)")
    .option("--stack <name>", "stack the template updates (required with --template)")
    .action(async (words: string[], o) => {
      const p = await c.profiles.resolve(o.system, o.env);
      if (!p.repository)
        throw new CliError(
          "cannot plan a change without a linked source repository (the IaC is the source of truth); reconnect with --repo",
        );
      const graph = await c.loadGraph(p);
      const evidence = new FileEvidenceStore(c.evidenceDir(p));
      const proposal = await proposePlan({
        intent: words.join(" "),
        graph,
        evidence,
        model: graph
          ? deps.model(o.model, p.region)
          : {
              converse: async () => {
                throw new Error("unreachable");
              },
            },
        now: deps.now(),
      });
      if (!proposal.ok || !graph)
        throw new CliError(proposal.ok ? "no discovery data" : proposal.reason);
      const rev = await (await RepoReader.open(p.repository.path)).revision();
      if (!rev.revision)
        throw new CliError(
          "the linked repository is not a git checkout; a source revision is required to bind approvals",
        );
      let artifact;
      if (o.template) {
        if (!o.stack) throw new CliError("--stack is required with --template");
        artifact = { stackName: o.stack, sha256: sha256(await deps.readFile(o.template)) };
      }
      const changeId = `chg-${deps.now().getTime().toString(36)}`;
      const m = proposal.plan;
      const svc = await service(p);
      const rec = await svc.submitPlan(
        {
          changeId,
          systemId: p.systemId,
          environment: p.environment,
          accountId: p.accountId,
          region: p.region,
          requestedBy: deps.actor,
          intent: words.join(" "),
          sourceRevision: `${rev.revision}${rev.dirty ? "+dirty" : ""}`,
          graphBuiltAt: graph.builtAt,
          graphFingerprint: fingerprintGraph(graph),
          evidence: proposal.evidenceIds,
          affected: m.affected,
          actions: m.actions,
          edits: m.edits,
          steps: m.steps,
          alternatives: m.alternatives,
          verification: m.verification,
          risks: m.risks,
          rollback: m.rollback,
          ...(artifact && { artifact }),
        },
        deps.actor,
      );
      deps.out(formatChange(rec));
      if (rev.dirty)
        deps.out(
          "\nNote: the working tree has uncommitted changes; the revision is marked +dirty and the plan will go stale once it is committed.",
        );
    });

  const changes = program
    .command("changes")
    .description("Review and execute proposed changes (approval-gated)");
  const common = (cmd: Command) => cmd.requiredOption("--system <id>").option("--env <name>");

  common(changes.command("list")).action(async (o) => {
    const { svc } = await locate("", o.system, o.env);
    for (const r of await svc.list())
      deps.out(
        `${r.plan.changeId}  ${r.state.padEnd(18)} ${r.plan.riskClass.padEnd(9)} ${r.plan.intent}`,
      );
  });
  common(changes.command("show <changeId>")).action(async (id, o) =>
    deps.out(formatChange(await (await locate(id, o.system, o.env)).svc.get(id))),
  );

  common(changes.command("validate <changeId>"))
    .option(
      "--check <command>",
      "command to run in an isolated copy of the repo (repeatable, no shell)",
      (v: string, p: string[]) => [...p, v],
      [] as string[],
    )
    .action(async (id, o) => {
      const { p, svc } = await locate(id, o.system, o.env);
      if (!p.repository) throw new CliError("no repository linked");
      const allowed = (o.check as string[]).map((line, i) => {
        const [file, ...args] = line.trim().split(/\s+/);
        return { name: `check-${i + 1}: ${line}`, file: file!, args };
      });
      const rec = await svc.validate(
        id,
        new LocalWorkerValidator({ repoPath: p.repository.path, allowed }),
        deps.actor,
      );
      deps.out(`${rec.validation?.report ?? ""}\n\nState: ${rec.state}`);
    });

  common(changes.command("approve <changeId>"))
    .option("--elevated", "approve an elevated-risk plan")
    .option("--ttl-minutes <n>", "approval lifetime", "60")
    .action(async (id, o) => {
      const { svc } = await locate(id, o.system, o.env);
      const rec = await svc.approve(id, deps.actor, {
        elevated: !!o.elevated,
        ttlMs: Number(o.ttlMinutes) * 60_000,
      });
      deps.out(
        `Approved ${id} for plan hash ${rec.plan.planHash} until ${rec.approval?.expiresAt}. Not applied yet.`,
      );
    });
  common(changes.command("reject <changeId>"))
    .option("--reason <text>", "reason", "rejected by reviewer")
    .action(async (id, o) => {
      deps.out(
        formatChange(
          await (await locate(id, o.system, o.env)).svc.reject(id, deps.actor, o.reason),
        ),
      );
    });

  common(changes.command("apply <changeId>"))
    .requiredOption("--template <file>", "the exact template that was approved")
    .action(async (id, o) => {
      const { p, svc } = await locate(id, o.system, o.env);
      const rec = await svc.get(id);
      const artifact = rec.plan.artifact;
      if (!artifact)
        throw new CliError(
          "this plan has no deployable artifact; apply it through your normal source/CI pipeline",
        );
      const body = await deps.readFile(o.template);
      if (sha256(body) !== artifact.sha256)
        throw new CliError(
          "template does not match the sha256 bound to the approved plan; refusing to deploy",
        );
      if (!p.repository) throw new CliError("no repository linked");
      const repo = await RepoReader.open(p.repository.path);
      const deployer = await deps.deployer(p, {
        stackName: artifact.stackName,
        templateBody: body,
      });
      const preflight = {
        async check(plan: ChangeRecord["plan"]) {
          const r = await repo.revision();
          const fresh = await c.refresh(p);
          const { read } = await deps.session(p);
          const status = await read.getStackStatus(artifact.stackName);
          return {
            sourceRevision: `${r.revision ?? "unknown"}${r.dirty ? "+dirty" : ""}`,
            driftDetected:
              !!plan.graphFingerprint && plan.graphFingerprint !== fingerprintGraph(fresh),
            healthy: isStackHealthy(status),
            healthDetail: `stack ${artifact.stackName} is ${status}`,
          };
        },
      };
      deps.out(formatChange(await svc.apply(id, deployer, preflight, deps.actor)));
    });

  common(changes.command("verify <changeId>"))
    .option("--confirm <ids>", "comma-separated criteria you confirmed manually", "")
    .action(async (id, o) => {
      const { svc } = await locate(id, o.system, o.env);
      const confirmed = new Set(String(o.confirm).split(",").filter(Boolean));
      const verifier: Verifier = {
        async verify(plan) {
          return plan.verification.map((v) =>
            confirmed.has(v.id)
              ? { id: v.id, passed: true, detail: "confirmed manually by operator" }
              : {
                  id: v.id,
                  passed: false,
                  detail:
                    v.kind === "manual"
                      ? "awaiting manual confirmation (--confirm)"
                      : `${v.kind} checks are not automated in this version; confirm with --confirm ${v.id}`,
                },
          );
        },
      };
      deps.out(formatChange(await svc.verify(id, verifier, deps.actor)));
    });
}
