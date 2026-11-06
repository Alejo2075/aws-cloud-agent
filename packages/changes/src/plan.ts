import { createHash } from "node:crypto";
import { z } from "zod";
import { AwsAccountId, AwsRegion } from "@cloud-agent/contracts";

export const ActionKind = z.enum([
  "update-config",
  "update-code",
  "create-resource",
  "delete-resource",
  "iam-expansion",
  "public-exposure",
  "data-migration",
  "secret-rotation",
  "cross-account-access",
  "delete-stack",
]);
export type ActionKind = z.infer<typeof ActionKind>;

export const RiskClass = z.enum(["routine", "elevated", "blocked"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const PlanDraft = z.object({
  changeId: z.string().min(1),
  systemId: z.string().min(1),
  environment: z.string().min(1),
  accountId: AwsAccountId,
  region: AwsRegion,
  requestedBy: z.string().min(1),
  intent: z.string().min(1),
  /** Source revision the diff was built against; approval is void if HEAD moves. */
  sourceRevision: z.string().min(1),
  graphBuiltAt: z.iso.datetime(),
  evidence: z.array(z.string()).default([]),
  affected: z.array(z.object({ resourceId: z.string(), impact: z.string() })).default([]),
  actions: z
    .array(z.object({ kind: ActionKind, resourceId: z.string(), description: z.string() }))
    .min(1),
  edits: z
    .array(z.object({ path: z.string(), summary: z.string(), patch: z.string() }))
    .default([]),
  steps: z.array(z.string()).min(1),
  alternatives: z.array(z.string()).default([]),
  verification: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        kind: z.enum(["test", "metric", "http", "manual"]),
      }),
    )
    .min(1),
  risks: z
    .array(
      z.object({
        category: z.enum(["iam", "data", "availability", "cost", "privacy", "migration"]),
        description: z.string(),
      }),
    )
    .default([]),
  rollback: z.object({
    strategy: z.string().min(1),
    reversible: z.boolean(),
    requiresBackup: z.boolean(),
  }),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

export type ChangePlan = PlanDraft & { riskClass: RiskClass; planHash: string };

/** Deterministic JSON: sorted keys so the same plan always hashes the same. */
export function canonicalize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonicalize(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const BLOCKED: ActionKind[] = ["delete-stack"];
const ELEVATED: ActionKind[] = [
  "delete-resource",
  "iam-expansion",
  "public-exposure",
  "data-migration",
  "secret-rotation",
  "cross-account-access",
];

/** Risk is derived from actions, never taken from the (model-written) draft. */
export function classifyRisk(d: Pick<PlanDraft, "actions" | "rollback">): RiskClass {
  if (d.actions.some((a) => BLOCKED.includes(a.kind))) return "blocked";
  if (d.actions.some((a) => ELEVATED.includes(a.kind))) return "elevated";
  // Irreversible changes without a recovery path are not "routine".
  if (!d.rollback.reversible && !d.rollback.requiresBackup) return "elevated";
  return "routine";
}

export function hashPlan(d: PlanDraft, riskClass: RiskClass): string {
  return createHash("sha256")
    .update(canonicalize({ ...d, riskClass }))
    .digest("hex");
}

export function finalizePlan(input: unknown): ChangePlan {
  const d = PlanDraft.parse(input);
  const riskClass = classifyRisk(d);
  return { ...d, riskClass, planHash: hashPlan(d, riskClass) };
}

export function verifyPlanIntegrity(p: ChangePlan): boolean {
  const { riskClass, planHash, ...draft } = p;
  return classifyRisk(draft) === riskClass && hashPlan(draft, riskClass) === planHash;
}
