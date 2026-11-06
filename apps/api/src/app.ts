import { randomUUID } from "node:crypto";
import { z } from "zod";
import { askSystem } from "@cloud-agent/agent";
import type { ModelPort } from "@cloud-agent/agent";
import type { ChangeService } from "@cloud-agent/changes";
import type { ConnectionProfile } from "@cloud-agent/contracts";
import type { AuditLog, EvidenceStore } from "@cloud-agent/evidence";
import type { GraphStore } from "@cloud-agent/graph";
import { RateLimiter } from "./auth.js";
import type { Authenticator, Authorizer } from "./auth.js";
import type { Action, ApiRequest, ApiResponse, Principal } from "./types.js";

export interface ApiDeps {
  authenticator: Authenticator;
  authorizer: Authorizer;
  profiles(): Promise<ConnectionProfile[]>;
  graphs: GraphStore;
  evidence(p: ConnectionProfile): EvidenceStore;
  changes(p: ConnectionProfile): ChangeService;
  model(p: ConnectionProfile): ModelPort;
  audit: AuditLog;
  rateLimiter?: RateLimiter;
  maxBodyBytes?: number;
  now?: () => Date;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const AskBody = z
  .object({ question: z.string().min(1).max(2000), environment: z.string().optional() })
  .strict();
const ApproveBody = z
  .object({
    elevated: z.boolean().default(false),
    ttlMinutes: z.number().int().min(1).max(1440).default(60),
  })
  .strict();

const json = (status: number, data: unknown, requestId: string): ApiResponse => ({
  status,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-request-id": requestId,
  },
  body: JSON.stringify(data),
});

/**
 * Framework-agnostic HTTP surface. Every route authenticates, authorizes per system+environment, and audits.
 * Reads, questions and approvals only: applying changes is deliberately not exposed over HTTP.
 * The audit/approval actor is always the authenticated principal, never a value from the request.
 */
export function createApi(deps: ApiDeps) {
  const limiter = deps.rateLimiter ?? new RateLimiter(60, 60_000);
  const maxBody = deps.maxBodyBytes ?? 64 * 1024;
  const now = deps.now ?? (() => new Date());

  async function target(
    principal: Principal,
    systemId: string,
    env: string | undefined,
    action: Action,
  ) {
    const matches = (await deps.profiles()).filter(
      (p) => p.systemId === systemId && (!env || p.environment === env),
    );
    // A caller with no grant at all on the system gets the same 404 as for a system that does not exist,
    // so system ids cannot be probed. Callers who hold some grant learn that this action is forbidden.
    const known = matches.filter((p) =>
      ["read", "ask", "approve", "approve-elevated"].some((a) =>
        deps.authorizer.can(
          principal,
          { systemId: p.systemId, environment: p.environment },
          a as Action,
        ),
      ),
    );
    const allowed = matches.filter((p) =>
      deps.authorizer.can(principal, { systemId: p.systemId, environment: p.environment }, action),
    );
    if (allowed.length === 0)
      throw new HttpError(known.length ? 403 : 404, known.length ? "forbidden" : "not found");
    if (allowed.length > 1)
      throw new HttpError(
        400,
        `several environments match; pass environment (${allowed.map((p) => p.environment).join(", ")})`,
      );
    return allowed[0]!;
  }

  function parseBody<T>(schema: z.ZodType<T>, raw: string | undefined): T {
    if (raw && Buffer.byteLength(raw) > maxBody) throw new HttpError(413, "request body too large");
    let value: unknown = {};
    if (raw) {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "body is not valid JSON");
      }
    }
    const r = schema.safeParse(value);
    if (!r.success)
      throw new HttpError(
        400,
        `invalid body: ${r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`,
      );
    return r.data;
  }

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    const requestId = randomUUID();
    let principal: Principal | undefined;
    try {
      principal = await deps.authenticator.authenticate(req.headers);
      if (!principal) throw new HttpError(401, "authentication required");
      if (!limiter.allow(principal.id)) throw new HttpError(429, "rate limit exceeded");
      const seg = req.path.split("?")[0]!.split("/").filter(Boolean);
      const m = req.method.toUpperCase();
      const env = req.query?.["environment"];

      if (m === "GET" && seg.length === 1 && seg[0] === "systems") {
        const visible = (await deps.profiles()).filter((p) =>
          deps.authorizer.can(
            principal!,
            { systemId: p.systemId, environment: p.environment },
            "read",
          ),
        );
        return json(
          200,
          visible.map((p) => ({
            systemId: p.systemId,
            environment: p.environment,
            region: p.region,
            lastDiscoveryAt: p.lastDiscoveryAt,
          })),
          requestId,
        );
      }
      if (seg[0] !== "systems" || !seg[1]) throw new HttpError(404, "not found");
      const systemId = decodeURIComponent(seg[1]);
      const route = seg.slice(2).join("/");

      if (m === "GET" && route === "graph") {
        const p = await target(principal, systemId, env, "read");
        const g = await deps.graphs.load(p);
        if (!g) throw new HttpError(404, "no discovery data for this system");
        return json(200, g, requestId);
      }
      if (m === "POST" && route === "ask") {
        const body = parseBody(AskBody, req.body);
        const p = await target(principal, systemId, body.environment ?? env, "ask");
        const answer = await askSystem({
          question: body.question,
          graph: await deps.graphs.load(p),
          evidence: deps.evidence(p),
          model: deps.model(p),
          now: now(),
          policy: { sensitiveDataAccess: p.sensitiveDataAccess, costDataAccess: p.costDataAccess },
        });
        await deps.audit.append(
          {
            actor: principal.id,
            action: "api.ask",
            systemId: p.systemId,
            environment: p.environment,
            outcome: "ok",
            detail: { question: body.question, evidence: answer.observations.map((o) => o.id) },
          },
          now(),
        );
        return json(200, answer, requestId);
      }
      if (m === "GET" && route === "changes") {
        const p = await target(principal, systemId, env, "read");
        return json(
          200,
          (await deps.changes(p).list()).map((r) => ({
            changeId: r.plan.changeId,
            state: r.state,
            riskClass: r.plan.riskClass,
            intent: r.plan.intent,
            planHash: r.plan.planHash,
          })),
          requestId,
        );
      }
      const change = /^changes\/([\w.-]+)(\/approve)?$/.exec(route);
      if (change && m === "GET" && !change[2]) {
        const p = await target(principal, systemId, env, "read");
        return json(200, await deps.changes(p).get(change[1]!), requestId);
      }
      if (change && m === "POST" && change[2]) {
        const body = parseBody(ApproveBody, req.body);
        const p = await target(principal, systemId, env, "approve");
        const svc = deps.changes(p);
        const rec = await svc.get(change[1]!);
        if (
          rec.plan.riskClass === "elevated" &&
          !deps.authorizer.can(
            principal,
            { systemId: p.systemId, environment: p.environment },
            "approve-elevated",
          )
        ) {
          throw new HttpError(403, "elevated-risk plans need an elevated approver");
        }
        const out = await svc.approve(change[1]!, principal.id, {
          elevated: rec.plan.riskClass === "elevated" && body.elevated,
          ttlMs: body.ttlMinutes * 60_000,
        });
        return json(
          200,
          { changeId: out.plan.changeId, state: out.state, approval: out.approval },
          requestId,
        );
      }
      if (m === "GET" && route === "audit") {
        const p = await target(principal, systemId, env, "read");
        return json(
          200,
          (await deps.audit.read())
            .filter(
              (r) =>
                r.systemId === p.systemId && (!r.environment || r.environment === p.environment),
            )
            .slice(-200),
          requestId,
        );
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, requestId }, requestId);
      // Never leak internals; correlate through the request id and the audit trail.
      await deps.audit
        .append(
          {
            actor: principal?.id ?? "anonymous",
            action: "api.error",
            systemId: "-",
            outcome: "error",
            detail: { requestId, path: req.path, error: (e as Error).message },
          },
          now(),
        )
        .catch(() => undefined);
      return json(500, { error: "internal error", requestId }, requestId);
    }
  };
}
