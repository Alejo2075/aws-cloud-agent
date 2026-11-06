import type { ChangePlan } from "./plan.js";

export const STATES = [
  "REQUESTED",
  "DISCOVERING",
  "ANALYZING",
  "PLANNING",
  "DIFF_READY",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "APPLYING",
  "VERIFYING",
  "COMPLETED",
  "NEEDS_INPUT",
  "REJECTED",
  "STALE_PLAN",
  "BLOCKED",
  "FAILED",
  "PARTIALLY_APPLIED",
  "ROLLBACK_REQUIRED",
  "CANCELLED",
] as const;
export type ChangeState = (typeof STATES)[number];

const T: Record<ChangeState, ChangeState[]> = {
  REQUESTED: ["DISCOVERING", "NEEDS_INPUT", "BLOCKED", "CANCELLED"],
  DISCOVERING: ["ANALYZING", "NEEDS_INPUT", "FAILED", "CANCELLED"],
  ANALYZING: ["PLANNING", "NEEDS_INPUT", "FAILED", "CANCELLED"],
  PLANNING: ["DIFF_READY", "NEEDS_INPUT", "BLOCKED", "FAILED", "CANCELLED"],
  DIFF_READY: ["VALIDATING", "BLOCKED", "STALE_PLAN", "CANCELLED"],
  VALIDATING: ["AWAITING_APPROVAL", "FAILED", "BLOCKED", "STALE_PLAN", "CANCELLED"],
  AWAITING_APPROVAL: ["APPLYING", "REJECTED", "STALE_PLAN", "CANCELLED"],
  APPLYING: ["VERIFYING", "FAILED", "PARTIALLY_APPLIED"],
  VERIFYING: ["COMPLETED", "ROLLBACK_REQUIRED", "FAILED"],
  PARTIALLY_APPLIED: ["APPLYING", "ROLLBACK_REQUIRED"],
  NEEDS_INPUT: ["DISCOVERING", "CANCELLED"],
  STALE_PLAN: ["PLANNING", "CANCELLED"],
  ROLLBACK_REQUIRED: [],
  COMPLETED: [],
  REJECTED: [],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: [],
};

export class TransitionError extends Error {}

export interface Approval {
  approvalId: string;
  changeId: string;
  planHash: string;
  sourceRevision: string;
  environment: string;
  accountId: string;
  region: string;
  actor: string;
  elevated: boolean;
  approvedAt: string;
  expiresAt: string;
  invalidatedAt?: string;
  invalidReason?: string;
}

export interface ExecutionRecord {
  idempotencyKey: string;
  status: "succeeded" | "failed" | "partial";
  startedAt: string;
  finishedAt: string;
  attempts: number;
  detail: string;
}

export interface VerificationRecord {
  passed: boolean;
  at: string;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
}

export interface ChangeRecord {
  plan: ChangePlan;
  state: ChangeState;
  history: Array<{
    from: ChangeState | null;
    to: ChangeState;
    at: string;
    actor: string;
    note?: string;
  }>;
  validation?: { passed: boolean; at: string; report: string };
  approval?: Approval;
  execution?: ExecutionRecord;
  verification?: VerificationRecord;
}

export function canTransition(from: ChangeState, to: ChangeState): boolean {
  return T[from].includes(to);
}

export function isTerminal(s: ChangeState): boolean {
  return T[s].length === 0;
}

/** Pure: returns a new record or throws. Every transition is recorded with actor and time. */
export function transition(
  rec: ChangeRecord,
  to: ChangeState,
  actor: string,
  now: Date,
  note?: string,
): ChangeRecord {
  if (!canTransition(rec.state, to))
    throw new TransitionError(`illegal transition ${rec.state} -> ${to}`);
  return {
    ...rec,
    state: to,
    history: [
      ...rec.history,
      { from: rec.state, to, at: now.toISOString(), actor, ...(note && { note }) },
    ],
  };
}
