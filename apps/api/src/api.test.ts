import { describe, expect, it } from "vitest";
import type { ModelPort } from "@cloud-agent/agent";
import { ChangeService, InMemoryChangeStore } from "@cloud-agent/changes";
import { ConnectionProfile } from "@cloud-agent/contracts";
import { discoverSystem, restaurantPort } from "@cloud-agent/discovery";
import { InMemoryAuditLog, InMemoryEvidenceStore, verifyChain } from "@cloud-agent/evidence";
import { InMemoryGraphStore } from "@cloud-agent/graph";
import { RateLimiter, createApi, grantAuthorizer, lambdaHandler } from "./index.js";
import type { ApiRequest, Principal } from "./index.js";

const profile = (env = "production") =>
  ConnectionProfile.parse({
    connectionId: `c-${env}`,
    systemId: "restaurant-app",
    ownerIdentity: "u",
    environment: env,
    accountId: "123456789012",
    region: "us-east-1",
    scope: { stacks: ["restaurant-app-prod"] },
    roles: { "read-only": "arn:aws:iam::123456789012:role/ro" },
  });
const users: Record<string, Principal> = {
  reader: { id: "user:reader", grants: [{ systemId: "restaurant-app", actions: ["read", "ask"] }] },
  approver: {
    id: "user:approver",
    grants: [{ systemId: "restaurant-app", actions: ["read", "approve"] }],
  },
  nobody: { id: "user:nobody", grants: [] },
};
const draft = {
  changeId: "chg-1",
  systemId: "restaurant-app",
  environment: "production",
  accountId: "123456789012",
  region: "us-east-1",
  requestedBy: "alice",
  intent: "i",
  sourceRevision: "r",
  graphBuiltAt: "2026-11-06T00:00:00.000Z",
  actions: [{ kind: "update-config", resourceId: "x", description: "d" }],
  steps: ["s"],
  verification: [{ id: "v", description: "d", kind: "test" }],
  rollback: { strategy: "revert", reversible: true, requiresBackup: false },
};

async function setup(
  over: { rateLimiter?: RateLimiter; model?: ModelPort; maxBodyBytes?: number } = {},
) {
  const p = profile();
  const graphs = new InMemoryGraphStore();
  const evidence = new InMemoryEvidenceStore();
  await graphs.save(await discoverSystem(p, restaurantPort(), evidence));
  const audit = new InMemoryAuditLog();
  const changes = new ChangeService({
    store: new InMemoryChangeStore(),
    audit,
    policy: { writeRoleConfigured: true },
  });
  await changes.submitPlan(draft, "alice");
  await changes.validate("chg-1", { validate: async () => ({ passed: true, report: "ok" }) }, "ci");
  const model: ModelPort = over.model ?? {
    converse: async () => ({
      stopReason: "tool_use",
      content: [
        {
          type: "toolUse",
          id: "1",
          name: "submit_answer",
          input: {
            answer: "Reservations enter through the API.",
            citedObservationIds: [],
            hypotheses: [],
            limitations: [],
          },
        },
      ],
    }),
  };
  const api = createApi({
    authenticator: {
      authenticate: async (h) => users[(h["authorization"] ?? "").replace("Bearer ", "")],
    },
    authorizer: grantAuthorizer,
    profiles: async () => [p],
    graphs,
    evidence: () => evidence,
    changes: () => changes,
    model: () => model,
    audit,
    ...(over.rateLimiter && { rateLimiter: over.rateLimiter }),
    ...(over.maxBodyBytes && { maxBodyBytes: over.maxBodyBytes }),
  });
  const call = async (
    as: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => {
    const r = await api({
      method,
      path,
      headers: as ? { authorization: `Bearer ${as}` } : {},
      ...(query && { query }),
      ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: r.status, json: JSON.parse(r.body), headers: r.headers };
  };
  return { call, audit, changes };
}

describe("API", () => {
  it("requires authentication and authorization, and hides unknown systems the same way as forbidden ones", async () => {
    const { call } = await setup();
    expect((await call(undefined, "GET", "/systems")).status).toBe(401);
    expect((await call("nobody", "GET", "/systems/restaurant-app/graph")).status).toBe(404);
    expect((await call("reader", "GET", "/systems/other/graph")).status).toBe(404);
    expect(
      (await call("approver", "POST", "/systems/restaurant-app/ask", { question: "hi" })).status,
    ).toBe(403);
    expect((await call("nobody", "GET", "/systems")).json).toEqual([]);
  });

  it("serves the graph and answers questions with evidence-backed structure, auditing the principal", async () => {
    const { call, audit } = await setup();
    const g = await call("reader", "GET", "/systems/restaurant-app/graph");
    expect(g.status).toBe(200);
    expect(g.json.resources.length).toBe(7);
    expect(g.headers["cache-control"]).toBe("no-store");
    const a = await call("reader", "POST", "/systems/restaurant-app/ask", {
      question: "How do reservations start?",
    });
    expect(a.status).toBe(200);
    expect(a.json.answer).toContain("Reservations");
    expect(a.json.limitations.join()).toContain("No evidence was cited");
    const rec = (await audit.read()).find((r) => r.action === "api.ask")!;
    expect(rec.actor).toBe("user:reader");
    expect(verifyChain(await audit.read()).ok).toBe(true);
  });

  it("takes the approval actor from the authenticated principal, never from the body", async () => {
    const { call, changes } = await setup();
    const bad = await call("approver", "POST", "/systems/restaurant-app/changes/chg-1/approve", {
      actor: "someone-else",
    });
    expect(bad.status).toBe(400);
    const ok = await call("approver", "POST", "/systems/restaurant-app/changes/chg-1/approve", {
      ttlMinutes: 30,
    });
    expect(ok.status).toBe(200);
    expect((await changes.get("chg-1")).approval?.actor).toBe("user:approver");
    expect(
      (await call("reader", "POST", "/systems/restaurant-app/changes/chg-1/approve", {})).status,
    ).toBe(403);
  });

  it("requires a separate grant for elevated approvals", async () => {
    const { call, changes } = await setup();
    await changes.submitPlan(
      {
        ...draft,
        changeId: "chg-2",
        actions: [{ kind: "iam-expansion", resourceId: "r", description: "wider" }],
      },
      "alice",
    );
    await changes.validate(
      "chg-2",
      { validate: async () => ({ passed: true, report: "ok" }) },
      "ci",
    );
    expect(
      (
        await call("approver", "POST", "/systems/restaurant-app/changes/chg-2/approve", {
          elevated: true,
        })
      ).status,
    ).toBe(403);
    users["elevated"] = {
      id: "user:elevated",
      grants: [{ systemId: "restaurant-app", actions: ["read", "approve", "approve-elevated"] }],
    };
    const r = await call("elevated", "POST", "/systems/restaurant-app/changes/chg-2/approve", {
      elevated: true,
    });
    expect(r.status).toBe(200);
    expect(r.json.approval.elevated).toBe(true);
  });

  it("exposes no way to apply or plan over HTTP", async () => {
    const { call } = await setup();
    for (const path of ["changes/chg-1/apply", "apply", "plan", "changes"])
      expect((await call("approver", "POST", `/systems/restaurant-app/${path}`, {})).status).toBe(
        404,
      );
  });

  it("validates input, bounds body size and rate-limits per principal", async () => {
    const { call } = await setup({ maxBodyBytes: 200, rateLimiter: new RateLimiter(5, 60_000) });
    expect((await call("reader", "POST", "/systems/restaurant-app/ask", "{not json")).status).toBe(
      400,
    );
    expect(
      (await call("reader", "POST", "/systems/restaurant-app/ask", { question: "" })).status,
    ).toBe(400);
    expect(
      (await call("reader", "POST", "/systems/restaurant-app/ask", { question: "x".repeat(500) }))
        .status,
    ).toBe(413);
    expect((await call("reader", "GET", "/systems")).status).toBe(200);
    expect((await call("reader", "GET", "/systems")).status).toBe(200);
    expect((await call("reader", "GET", "/systems")).status).toBe(429);
  });

  it("returns an opaque 500 with a request id and records the failure in the audit trail", async () => {
    const { call, audit } = await setup({
      model: {
        converse: async () => {
          throw new Error("secret internal detail: db password=hunter2");
        },
      },
    });
    const r = await call("reader", "POST", "/systems/restaurant-app/ask", { question: "q" });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain("hunter2");
    expect(r.json.requestId).toBe(r.headers["x-request-id"]);
    expect((await audit.read()).some((x) => x.action === "api.error")).toBe(true);
  });
});

describe("lambdaHandler", () => {
  it("maps API Gateway HTTP API events, including base64 bodies and header casing", async () => {
    let seen: ApiRequest | undefined;
    const h = lambdaHandler(async (r) => {
      seen = r;
      return { status: 201, headers: { "x-a": "b" }, body: "{}" };
    });
    const res = await h({
      rawPath: "/systems/x/ask",
      headers: { Authorization: "Bearer t" },
      queryStringParameters: { environment: "prod" },
      body: Buffer.from('{"q":1}').toString("base64"),
      isBase64Encoded: true,
      requestContext: { http: { method: "POST" } },
    });
    expect(res).toEqual({ statusCode: 201, headers: { "x-a": "b" }, body: "{}" });
    expect(seen).toMatchObject({
      method: "POST",
      path: "/systems/x/ask",
      headers: { authorization: "Bearer t" },
      query: { environment: "prod" },
      body: '{"q":1}',
    });
  });
});
