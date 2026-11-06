import { describe, expect, it } from "vitest";
import { InMemoryAuditLog, verifyChain } from "@cloud-agent/evidence";
import {
  ChangeError,
  ChangeService,
  InMemoryChangeStore,
  TransitionError,
  finalizePlan,
  transition,
  verifyPlanIntegrity,
} from "./index.js";
import type { Deployer, Preflight, Validator, Verifier } from "./index.js";

const draft = (over: Record<string, unknown> = {}) => ({
  changeId: "chg-1",
  systemId: "restaurant-app",
  environment: "production",
  accountId: "123456789012",
  region: "us-east-1",
  requestedBy: "alice",
  intent: "Set checkout timeout to 20s",
  sourceRevision: "f00ba4",
  graphBuiltAt: "2026-11-06T00:00:00.000Z",
  actions: [{ kind: "update-config", resourceId: "fn", description: "timeout 10 -> 20" }],
  steps: ["edit lib/stack.ts", "deploy via pipeline"],
  verification: [{ id: "v1", description: "timeout is 20", kind: "test" }],
  rollback: { strategy: "revert commit and redeploy", reversible: true, requiresBackup: false },
  ...over,
});

const ok: Validator = { validate: async () => ({ passed: true, report: "tests passed" }) };
const live = (over = {}): Preflight => ({
  check: async () => ({ sourceRevision: "f00ba4", driftDetected: false, healthy: true, ...over }),
});
const mkDeployer = (statuses: Array<"succeeded" | "failed" | "partial">, retryable = false) => {
  const calls: unknown[] = [];
  const d: Deployer = {
    apply: async (_p, auth) => {
      calls.push(auth);
      return { status: statuses.shift() ?? "succeeded", detail: "d", retryable };
    },
  };
  return { d, calls };
};

function setup(cfg = {}) {
  const audit = new InMemoryAuditLog();
  let t = Date.parse("2026-11-06T12:00:00Z");
  const svc = new ChangeService({
    store: new InMemoryChangeStore(),
    audit,
    policy: { writeRoleConfigured: true, ...cfg },
    now: () => new Date(t),
  });
  return {
    svc,
    audit,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function ready(s: ReturnType<typeof setup>, d = draft(), approver = "bob", elevated = false) {
  await s.svc.submitPlan(d, "alice");
  await s.svc.validate(d.changeId, ok, "ci");
  return s.svc.approve(d.changeId, approver, { elevated });
}

describe("plan hashing and risk", () => {
  it("is deterministic and tamper-evident", () => {
    const p = finalizePlan(draft());
    expect(finalizePlan(draft()).planHash).toBe(p.planHash);
    expect(verifyPlanIntegrity(p)).toBe(true);
    expect(verifyPlanIntegrity({ ...p, intent: "something else" })).toBe(false);
    expect(verifyPlanIntegrity({ ...p, riskClass: "elevated" })).toBe(false);
  });
  it("derives risk from actions, not from the draft", () => {
    expect(finalizePlan(draft()).riskClass).toBe("routine");
    expect(
      finalizePlan(
        draft({ actions: [{ kind: "iam-expansion", resourceId: "r", description: "d" }] }),
      ).riskClass,
    ).toBe("elevated");
    expect(
      finalizePlan(
        draft({ actions: [{ kind: "delete-stack", resourceId: "s", description: "d" }] }),
      ).riskClass,
    ).toBe("blocked");
    expect(
      finalizePlan(
        draft({ rollback: { strategy: "none", reversible: false, requiresBackup: false } }),
      ).riskClass,
    ).toBe("elevated");
    expect(finalizePlan({ ...draft(), riskClass: "routine" } as never).riskClass).toBe("routine");
  });
  it("rejects plans without verification criteria or rollback", () => {
    expect(() => finalizePlan(draft({ verification: [] }))).toThrow();
    expect(() => finalizePlan(draft({ rollback: undefined }))).toThrow();
  });
});

describe("state machine", () => {
  it("rejects illegal transitions", () => {
    const rec = { plan: finalizePlan(draft()), state: "REQUESTED" as const, history: [] };
    expect(() => transition(rec, "APPLYING", "x", new Date())).toThrow(TransitionError);
  });
});

describe("change lifecycle", () => {
  it("runs plan -> validate -> approve -> apply -> verify with a verifiable audit trail", async () => {
    const s = setup();
    await ready(s);
    const { d, calls } = mkDeployer(["succeeded"]);
    const applied = await s.svc.apply("chg-1", d, live(), "bob");
    expect(applied.state).toBe("VERIFYING");
    expect(calls).toHaveLength(1);
    const done = await s.svc.verify(
      "chg-1",
      { verify: async () => [{ id: "v1", passed: true, detail: "ok" }] } as Verifier,
      "ci",
    );
    expect(done.state).toBe("COMPLETED");
    expect(verifyChain(await s.audit.read()).ok).toBe(true);
    expect(
      (await s.audit.read()).some(
        (r) => r.action === "change.approve" && r.planHash === done.plan.planHash,
      ),
    ).toBe(true);
  });

  it("never applies without approval, validation, or a write role", async () => {
    const s = setup();
    await s.svc.submitPlan(draft(), "alice");
    const { d, calls } = mkDeployer(["succeeded"]);
    await expect(s.svc.apply("chg-1", d, live(), "bob")).rejects.toThrow(ChangeError);
    expect(calls).toHaveLength(0);
    const s2 = setup({ writeRoleConfigured: false });
    await ready(s2);
    await expect(s2.svc.apply("chg-1", d, live(), "bob")).rejects.toThrow("no write role");
    expect(calls).toHaveLength(0);
  });

  it("invalidates the approval and goes STALE_PLAN when source or resources moved", async () => {
    const s = setup();
    await ready(s);
    const { d, calls } = mkDeployer(["succeeded"]);
    const rec = await s.svc.apply("chg-1", d, live({ sourceRevision: "deadbeef" }), "bob");
    expect(rec.state).toBe("STALE_PLAN");
    expect(rec.approval?.invalidatedAt).toBeDefined();
    expect(calls).toHaveLength(0);
    const s2 = setup();
    await ready(s2);
    expect((await s2.svc.apply("chg-1", d, live({ driftDetected: true }), "bob")).state).toBe(
      "STALE_PLAN",
    );
  });

  it("refuses expired approvals and unhealthy targets", async () => {
    const s = setup();
    await ready(s);
    s.advance(2 * 3600_000);
    const { d } = mkDeployer(["succeeded"]);
    await expect(s.svc.apply("chg-1", d, live(), "bob")).rejects.toThrow("expired");
    const s2 = setup();
    await ready(s2);
    await expect(s2.svc.apply("chg-1", d, live({ healthy: false }), "bob")).rejects.toThrow(
      "unhealthy",
    );
  });

  it("requires a distinct, elevated approver for elevated plans and blocks blocked ones", async () => {
    const elevated = draft({
      actions: [{ kind: "iam-expansion", resourceId: "r", description: "wider role" }],
    });
    const { d } = mkDeployer(["succeeded"]);
    const s = setup({ elevatedApprovers: ["carol"] });
    await ready(s, elevated, "bob", false);
    await expect(s.svc.apply("chg-1", d, live(), "bob")).rejects.toThrow("elevated approval");
    const s2 = setup();
    await ready(s2, elevated, "alice", true);
    await expect(s2.svc.apply("chg-1", d, live(), "alice")).rejects.toThrow("requester");
    const s3 = setup({ elevatedApprovers: ["carol"] });
    await ready(s3, elevated, "carol", true);
    expect((await s3.svc.apply("chg-1", d, live(), "carol")).state).toBe("VERIFYING");
    const s4 = setup();
    const b = await s4.svc.submitPlan(
      draft({ actions: [{ kind: "delete-stack", resourceId: "s", description: "d" }] }),
      "alice",
    );
    expect(b.state).toBe("BLOCKED");
  });

  it("is idempotent: a repeated apply returns the prior execution without redeploying", async () => {
    const s = setup();
    await ready(s);
    const { d, calls } = mkDeployer(["succeeded", "succeeded"]);
    await s.svc.apply("chg-1", d, live(), "bob");
    const again = await s.svc.apply("chg-1", d, live(), "bob");
    expect(again.execution?.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("retries only transient failures of non-destructive plans", async () => {
    const s = setup();
    await ready(s);
    const t = mkDeployer(["failed", "succeeded"], true);
    const rec = await s.svc.apply("chg-1", t.d, live(), "bob");
    expect(rec.execution?.attempts).toBe(2);
    const s2 = setup();
    const destructive = draft({
      actions: [{ kind: "delete-resource", resourceId: "t", description: "drop table" }],
    });
    await ready(s2, destructive, "carol", true);
    const t2 = mkDeployer(["failed", "succeeded"], true);
    const rec2 = await s2.svc.apply("chg-1", t2.d, live(), "carol");
    expect(rec2.state).toBe("FAILED");
    expect(t2.calls).toHaveLength(1);
  });

  it("reports partial application and separates verification failure from deploy failure", async () => {
    const s = setup();
    await ready(s);
    expect((await s.svc.apply("chg-1", mkDeployer(["partial"]).d, live(), "bob")).state).toBe(
      "PARTIALLY_APPLIED",
    );
    const s2 = setup();
    await ready(s2);
    await s2.svc.apply("chg-1", mkDeployer(["succeeded"]).d, live(), "bob");
    const v = await s2.svc.verify(
      "chg-1",
      { verify: async () => [{ id: "v1", passed: false, detail: "still 10s" }] },
      "ci",
    );
    expect(v.state).toBe("ROLLBACK_REQUIRED");
    expect(v.execution?.status).toBe("succeeded");
  });

  it("fails validation without reaching approval", async () => {
    const s = setup();
    await s.svc.submitPlan(draft(), "alice");
    const r = await s.svc.validate(
      "chg-1",
      { validate: async () => ({ passed: false, report: "2 tests failed" }) },
      "ci",
    );
    expect(r.state).toBe("FAILED");
    await expect(s.svc.approve("chg-1", "bob")).rejects.toThrow("only AWAITING_APPROVAL");
  });
});
