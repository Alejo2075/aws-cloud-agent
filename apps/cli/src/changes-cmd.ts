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
import { isStackHealthy, physicalIdFromArn } from "@cloud-agent/tools-aws";
import { RepoReader } from "@cloud-agent/tools-git";
import { GitBranchDeployer } from "@cloud-agent/deployments";
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
  const service = async (p: ConnectionProfile) => {
    const events = await deps.events?.(p);
    return new ChangeService({
      store: new FileChangeStore(
        join(deps.home, "changes", p.accountId, p.region, p.systemId, p.environment),
      ),
      audit: c.audit,
      policy: { writeRoleConfigured: !!p.roles.write },
      ...(events && { events }),
      now: deps.now,
    });
  };

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
    .option(
      "--codebuild <project>",
      "validate in an isolated CodeBuild project instead of a local copy",
    )
    .action(async (id, o) => {
      const { p, svc } = await locate(id, o.system, o.env);
      if (o.codebuild) {
        if (!deps.codeBuildValidator)
          throw new CliError("CodeBuild validation is not available in this environment");
        const rec = await svc.validate(
          id,
          await deps.codeBuildValidator(p, o.codebuild),
          deps.actor,
        );
        return deps.out(`${rec.validation?.report ?? ""}\n\nState: ${rec.state}`);
      }
      if (!p.repository) throw new CliError("no repository linked");
      const allowed = (o.check as string[]).map((line, i) => {
        const [file, ...args] = line.trim().split(/\s+/);
        return { name: `check-${i + 1}: ${line}`, file: file!, args };
      });
      const rec = await svc.validate(
        id,
        new LocalWorkerValidator({
          repoPath: p.repository.path,
          allowed,
        }),
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
    .option("--template <file>", "the exact template that was approved (plans that deploy a stack)")
    .option("--push", "push the created branch to the remote (plans that carry patches)")
    .option(
      "--pr-base <branch>",
      "open a pull request against this branch (requires --push and gh)",
    )
    .option(
      "--ignore-alarms",
      "proceed although alarms are firing on in-scope resources (recorded in the audit trail)",
    )
    .action(async (id, o) => {
      const { p, svc } = await locate(id, o.system, o.env);
      const rec = await svc.get(id);
      if (!p.repository) throw new CliError("no repository linked");
      const repo = await RepoReader.open(p.repository.path);
      const artifact = rec.plan.artifact;
      let deployer;
      let stack: string | undefined;
      if (artifact) {
        if (!o.template)
          throw new CliError("this plan deploys a stack; pass the approved --template");
        const body = await deps.readFile(o.template);
        if (sha256(body) !== artifact.sha256)
          throw new CliError(
            "template does not match the sha256 bound to the approved plan; refusing to deploy",
          );
        stack = artifact.stackName;
        deployer = await deps.deployer(p, { stackName: artifact.stackName, templateBody: body });
      } else if (rec.plan.edits.length) {
        if (o.prBase && !o.push) throw new CliError("--pr-base requires --push");
        deployer = new GitBranchDeployer({
          repoPath: p.repository.path,
          push: !!o.push,
          ...(o.prBase && { pullRequest: { base: o.prBase } }),
        });
      } else {
        throw new CliError(
          "this plan has no template or patches to apply; use your normal pipeline",
        );
      }
      const preflight = {
        async check(plan: ChangeRecord["plan"]) {
          const r = await repo.revision();
          const fresh = await c.refresh(p);
          const session = await deps.session(p);
          const status = stack ? await session.read.getStackStatus(stack) : undefined;
          const graph = await c.loadGraph(p);
          const watched = (graph?.resources ?? []).flatMap((x) =>
            x.arn
              ? [
                  {
                    id: x.id,
                    arn: x.arn,
                    type: x.type,
                    physicalId: physicalIdFromArn(x.arn, fresh),
                  },
                ]
              : [],
          );
          // Alarm status is part of the health gate and fails closed: if it cannot be read, it is "unverified".
          let alarms: Array<{ name: string }> = [];
          let unverified: string | undefined;
          if (!session.observe) unverified = "no observability access is configured";
          else {
            try {
              alarms = await session.observe.activeAlarms(watched);
            } catch (e) {
              unverified = `alarms could not be read (${(e as Error).message})`;
            }
          }
          const acknowledged = !!o.ignoreAlarms && (alarms.length > 0 || !!unverified);
          if (acknowledged) {
            await c.audit.append(
              {
                actor: deps.actor,
                action: unverified
                  ? "change.alarms_unverified_acknowledged"
                  : "change.alarms_acknowledged",
                systemId: p.systemId,
                environment: p.environment,
                planHash: plan.planHash,
                outcome: "ok",
                detail: { alarms: alarms.map((a) => a.name), unverified },
              },
              deps.now(),
            );
          }
          const alarmsOk = (alarms.length === 0 && !unverified) || acknowledged;
          const parts = [
            status === undefined
              ? "source-only change (no stack deployment)"
              : `stack ${stack} is ${status}`,
          ];
          if (alarms.length)
            parts.push(`${alarms.length} alarm(s) firing: ${alarms.map((a) => a.name).join(", ")}`);
          if (unverified) parts.push(`alarm status UNVERIFIED: ${unverified}`);
          if (acknowledged) parts.push("acknowledged by operator (--ignore-alarms)");
          return {
            sourceRevision: `${r.revision ?? "unknown"}${r.dirty ? "+dirty" : ""}`,
            driftDetected:
              !!plan.graphFingerprint && plan.graphFingerprint !== fingerprintGraph(fresh),
            healthy: (status === undefined ? true : isStackHealthy(status)) && alarmsOk,
            healthDetail: parts.join("; "),
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
