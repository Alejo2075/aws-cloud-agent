import { verifyPlanIntegrity } from "./plan.js";
import type { ChangePlan } from "./plan.js";
import type { Approval, ChangeRecord } from "./state.js";

declare const authorizationBrand: unique symbol;

/**
 * Proof that policy allowed exactly this plan against exactly this target right now.
 * Only authorizeApply can mint one; deployers require it, so no code path applies without policy.
 */
export interface Authorization {
  readonly [authorizationBrand]: true;
  readonly changeId: string;
  readonly planHash: string;
  readonly approvalId: string;
  readonly environment: string;
  readonly accountId: string;
  readonly region: string;
  readonly idempotencyKey: string;
}

export interface LiveState {
  /** Revision of the source repository right now. */
  sourceRevision: string;
  /** True when live resources changed since the plan was made. */
  driftDetected: boolean;
  /** True when the target environment is healthy enough to change. */
  healthy: boolean;
  /** What the health check observed, shown in the refusal reason. */
  healthDetail?: string;
}

export interface PolicyConfig {
  /** If set, elevated approvals must come from these actors. */
  elevatedApprovers?: string[];
  /** Whether a write-capable role is configured for this connection. */
  writeRoleConfigured: boolean;
}

export interface Decision {
  allowed: boolean;
  /** When true the approval must be discarded and the plan re-planned. */
  stale: boolean;
  reasons: string[];
  authorization?: Authorization;
}

export function idempotencyKeyFor(plan: ChangePlan): string {
  return `${plan.changeId}:${plan.planHash}:${plan.accountId}:${plan.region}:${plan.environment}`;
}

export function authorizeApply(
  rec: ChangeRecord,
  live: LiveState,
  cfg: PolicyConfig,
  now: Date,
): Decision {
  const { plan, approval } = rec;
  const reasons: string[] = [];
  let stale = false;

  if (!verifyPlanIntegrity(plan))
    reasons.push("plan content does not match its hash or risk class");
  if (plan.riskClass === "blocked")
    reasons.push("plan contains an action that is blocked by default");
  if (rec.state !== "AWAITING_APPROVAL")
    reasons.push(`change is ${rec.state}, not AWAITING_APPROVAL`);
  if (!cfg.writeRoleConfigured) reasons.push("no write role is configured for this connection");
  if (!rec.validation?.passed) reasons.push("validation has not passed");

  if (!approval) reasons.push("no approval recorded");
  else {
    const a: Approval = approval;
    if (a.invalidatedAt)
      reasons.push(`approval was invalidated: ${a.invalidReason ?? "unspecified"}`);
    if (a.planHash !== plan.planHash) {
      reasons.push("approval is bound to a different plan hash");
      stale = true;
    }
    if (a.changeId !== plan.changeId) reasons.push("approval is for a different change");
    if (
      a.environment !== plan.environment ||
      a.accountId !== plan.accountId ||
      a.region !== plan.region
    )
      reasons.push("approval target (environment/account/region) differs from the plan");
    if (a.sourceRevision !== plan.sourceRevision) {
      reasons.push("approval source revision differs from the plan");
      stale = true;
    }
    if (Date.parse(a.expiresAt) <= now.getTime()) reasons.push("approval has expired");
    if (plan.riskClass === "elevated") {
      if (!a.elevated) reasons.push("elevated-risk plan needs an elevated approval");
      if (a.actor === plan.requestedBy)
        reasons.push("elevated approval cannot come from the requester");
      if (cfg.elevatedApprovers && !cfg.elevatedApprovers.includes(a.actor))
        reasons.push("approver is not an authorized elevated approver");
    }
  }

  if (live.sourceRevision !== plan.sourceRevision) {
    reasons.push(`source moved from ${plan.sourceRevision} to ${live.sourceRevision}`);
    stale = true;
  }
  if (live.driftDetected) {
    reasons.push("live resources drifted since the plan was made");
    stale = true;
  }
  if (!live.healthy)
    reasons.push(
      `target environment is unhealthy${live.healthDetail ? ` (${live.healthDetail})` : ""}; refusing to change it`,
    );

  if (reasons.length) return { allowed: false, stale, reasons };
  const authorization = {
    changeId: plan.changeId,
    planHash: plan.planHash,
    approvalId: approval!.approvalId,
    environment: plan.environment,
    accountId: plan.accountId,
    region: plan.region,
    idempotencyKey: idempotencyKeyFor(plan),
  } as Authorization;
  return { allowed: true, stale: false, reasons: [], authorization };
}
