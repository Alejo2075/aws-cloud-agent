import { randomUUID } from "node:crypto";
import type { AuditLog } from "@cloud-agent/evidence";
import { finalizePlan } from "./plan.js";
import type { ChangePlan } from "./plan.js";
import { authorizeApply } from "./policy.js";
import type { PolicyConfig } from "./policy.js";
import type {
  Deployer,
  EventPublisher,
  LifecycleEvent,
  Preflight,
  Validator,
  Verifier,
} from "./ports.js";
import { transition } from "./state.js";
import type { ChangeRecord, ChangeState } from "./state.js";
import type { ChangeStore } from "./store.js";

export class ChangeError extends Error {}

export interface ChangeServiceDeps {
  store: ChangeStore;
  audit: AuditLog;
  policy: PolicyConfig;
  events?: EventPublisher;
  now?: () => Date;
}

const MAX_TRANSIENT_ATTEMPTS = 2;
const DESTRUCTIVE = new Set([
  "delete-resource",
  "delete-stack",
  "data-migration",
  "secret-rotation",
]);

export class ChangeService {
  constructor(private readonly d: ChangeServiceDeps) {}
  private now() {
    return this.d.now?.() ?? new Date();
  }

  private async emit(
    rec: ChangeRecord,
    type: LifecycleEvent["type"],
    extra: Partial<LifecycleEvent> = {},
  ) {
    if (!this.d.events) return;
    const p = rec.plan;
    const event: LifecycleEvent = {
      type,
      changeId: p.changeId,
      systemId: p.systemId,
      environment: p.environment,
      accountId: p.accountId,
      region: p.region,
      planHash: p.planHash,
      riskClass: p.riskClass,
      at: this.now().toISOString(),
      ...extra,
    };
    try {
      await this.d.events.publish(event);
    } catch (e) {
      // Notifications must never fail or block a change; record the miss instead.
      await this.d.audit.append(
        {
          actor: "system",
          action: "event.publish_failed",
          systemId: p.systemId,
          environment: p.environment,
          outcome: "error",
          detail: { changeId: p.changeId, type, error: (e as Error).message },
        },
        this.now(),
      );
    }
  }

  private async load(id: string): Promise<ChangeRecord> {
    const r = await this.d.store.get(id);
    if (!r) throw new ChangeError(`unknown change ${id}`);
    return r;
  }

  private async move(
    rec: ChangeRecord,
    to: ChangeState,
    actor: string,
    note?: string,
  ): Promise<ChangeRecord> {
    const next = transition(rec, to, actor, this.now(), note);
    await this.d.store.put(next);
    await this.d.audit.append(
      {
        actor,
        action: `change.${to}`,
        systemId: rec.plan.systemId,
        environment: rec.plan.environment,
        target: `${rec.plan.accountId}/${rec.plan.region}`,
        planHash: rec.plan.planHash,
        ...(rec.approval && { approvalId: rec.approval.approvalId }),
        outcome: to === "FAILED" || to === "BLOCKED" ? "error" : "ok",
        detail: { changeId: rec.plan.changeId, from: rec.state, ...(note && { note }) },
      },
      this.now(),
    );
    await this.emit(next, "change.state-changed", { from: rec.state, to });
    return next;
  }

  /** Records a finished plan. Discovery and analysis already happened (read-only); this never writes to AWS. */
  async submitPlan(draft: unknown, actor: string): Promise<ChangeRecord> {
    const plan = finalizePlan(draft);
    if (await this.d.store.get(plan.changeId))
      throw new ChangeError(`change ${plan.changeId} already exists`);
    let rec: ChangeRecord = {
      plan,
      state: "REQUESTED",
      history: [{ from: null, to: "REQUESTED", at: this.now().toISOString(), actor }],
    };
    await this.d.store.put(rec);
    for (const s of ["DISCOVERING", "ANALYZING", "PLANNING"] as const)
      rec = await this.move(rec, s, actor);
    if (plan.riskClass === "blocked")
      return this.move(
        rec,
        "BLOCKED",
        actor,
        "plan contains blocked actions; needs an explicit high-risk procedure",
      );
    return this.move(rec, "DIFF_READY", actor);
  }

  async validate(changeId: string, validator: Validator, actor: string): Promise<ChangeRecord> {
    let rec = await this.move(await this.load(changeId), "VALIDATING", actor);
    const r = await validator.validate(rec.plan);
    rec = {
      ...rec,
      validation: {
        passed: r.passed,
        at: this.now().toISOString(),
        report: r.report.slice(0, 4000),
      },
    };
    return this.move(
      rec,
      r.passed ? "AWAITING_APPROVAL" : "FAILED",
      actor,
      r.passed ? undefined : "validation failed",
    );
  }

  async approve(
    changeId: string,
    actor: string,
    opts: { elevated?: boolean; ttlMs?: number } = {},
  ): Promise<ChangeRecord> {
    const rec = await this.load(changeId);
    if (rec.state !== "AWAITING_APPROVAL")
      throw new ChangeError(
        `change is ${rec.state}; only AWAITING_APPROVAL changes can be approved`,
      );
    const { plan } = rec;
    const now = this.now();
    const approval = {
      approvalId: randomUUID(),
      changeId,
      planHash: plan.planHash,
      sourceRevision: plan.sourceRevision,
      environment: plan.environment,
      accountId: plan.accountId,
      region: plan.region,
      actor,
      elevated: opts.elevated ?? false,
      approvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? 3600_000)).toISOString(),
    };
    const next = { ...rec, approval };
    await this.d.store.put(next);
    await this.d.audit.append(
      {
        actor,
        action: "change.approve",
        systemId: plan.systemId,
        environment: plan.environment,
        target: `${plan.accountId}/${plan.region}`,
        planHash: plan.planHash,
        approvalId: approval.approvalId,
        outcome: "ok",
        detail: { changeId, elevated: approval.elevated, expiresAt: approval.expiresAt },
      },
      now,
    );
    await this.emit(next, "change.approved");
    return next;
  }

  async reject(changeId: string, actor: string, reason: string): Promise<ChangeRecord> {
    return this.move(await this.load(changeId), "REJECTED", actor, reason);
  }

  async cancel(changeId: string, actor: string): Promise<ChangeRecord> {
    return this.move(await this.load(changeId), "CANCELLED", actor);
  }

  /** Re-checks drift and source right before the write, then deploys only with a policy-minted Authorization. */
  async apply(
    changeId: string,
    deployer: Deployer,
    preflight: Preflight,
    actor: string,
  ): Promise<ChangeRecord> {
    let rec = await this.load(changeId);
    const dup = rec.approval
      ? await this.d.store.findExecution(
          `${rec.plan.changeId}:${rec.plan.planHash}:${rec.plan.accountId}:${rec.plan.region}:${rec.plan.environment}`,
        )
      : undefined;
    if (dup?.execution) return dup;

    const live = await preflight.check(rec.plan);
    const decision = authorizeApply(rec, live, this.d.policy, this.now());
    if (!decision.allowed || !decision.authorization) {
      await this.d.audit.append(
        {
          actor,
          action: "change.apply",
          systemId: rec.plan.systemId,
          environment: rec.plan.environment,
          planHash: rec.plan.planHash,
          outcome: "denied",
          detail: { changeId, reasons: decision.reasons },
        },
        this.now(),
      );
      if (decision.stale && rec.state === "AWAITING_APPROVAL") {
        const voided = rec.approval
          ? {
              ...rec.approval,
              invalidatedAt: this.now().toISOString(),
              invalidReason: decision.reasons.join("; "),
            }
          : undefined;
        rec = await this.move(
          { ...rec, ...(voided && { approval: voided }) },
          "STALE_PLAN",
          actor,
          decision.reasons.join("; "),
        );
        return rec;
      }
      throw new ChangeError(`apply denied: ${decision.reasons.join("; ")}`);
    }
    const auth = decision.authorization;
    rec = await this.move(rec, "APPLYING", actor);
    const started = this.now();
    const destructive = rec.plan.actions.some((a) => DESTRUCTIVE.has(a.kind));
    let attempts = 0;
    let result;
    do {
      attempts++;
      result = await deployer.apply(rec.plan, auth);
    } while (
      result.status === "failed" &&
      result.retryable &&
      !destructive &&
      attempts < MAX_TRANSIENT_ATTEMPTS
    );

    rec = {
      ...rec,
      execution: {
        idempotencyKey: auth.idempotencyKey,
        status: result.status,
        startedAt: started.toISOString(),
        finishedAt: this.now().toISOString(),
        attempts,
        detail: result.detail.slice(0, 2000),
      },
    };
    const to: ChangeState =
      result.status === "succeeded"
        ? "VERIFYING"
        : result.status === "partial"
          ? "PARTIALLY_APPLIED"
          : "FAILED";
    return this.move(rec, to, actor, result.detail.slice(0, 500));
  }

  /** Verification failure is distinct from deployment failure: the change was applied but did not meet criteria. */
  async verify(changeId: string, verifier: Verifier, actor: string): Promise<ChangeRecord> {
    let rec = await this.load(changeId);
    if (rec.state !== "VERIFYING")
      throw new ChangeError(`change is ${rec.state}; nothing to verify`);
    const checks = await verifier.verify(rec.plan);
    const passed = checks.length > 0 && checks.every((c) => c.passed);
    rec = { ...rec, verification: { passed, at: this.now().toISOString(), checks } };
    return this.move(
      rec,
      passed ? "COMPLETED" : "ROLLBACK_REQUIRED",
      actor,
      passed ? undefined : "applied, but verification criteria were not met",
    );
  }

  get(changeId: string) {
    return this.load(changeId);
  }
  list() {
    return this.d.store.list();
  }
}

export type { ChangePlan };
