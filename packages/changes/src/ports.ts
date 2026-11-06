import type { Authorization } from "./policy.js";
import type { ChangePlan } from "./plan.js";

export interface DeployResult {
  status: "succeeded" | "failed" | "partial";
  detail: string;
  /** Only transient, idempotent failures may set this; the service never retries destructive plans. */
  retryable?: boolean;
}

/** Writes happen only through this port, and only with an Authorization minted by policy. */
export interface Deployer {
  apply(plan: ChangePlan, auth: Authorization): Promise<DeployResult>;
}

export interface Validator {
  validate(plan: ChangePlan): Promise<{ passed: boolean; report: string }>;
}

export interface Verifier {
  verify(plan: ChangePlan): Promise<Array<{ id: string; passed: boolean; detail: string }>>;
}

/** Fresh read-only look at the world immediately before a write. */
export interface Preflight {
  check(
    plan: ChangePlan,
  ): Promise<{ sourceRevision: string; driftDetected: boolean; healthy: boolean }>;
}
