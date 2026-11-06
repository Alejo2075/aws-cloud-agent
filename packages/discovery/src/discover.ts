import { evaluateScope } from "@cloud-agent/connections";
import { SystemGraph } from "@cloud-agent/contracts";
import type { ConnectionProfile, GraphEdge, GraphResource } from "@cloud-agent/contracts";
import type { EvidenceStore } from "@cloud-agent/evidence";
import type { GraphStore } from "@cloud-agent/graph";
import { AccessDeniedError, arnFor, physicalIdFromArn, typeFromArn } from "@cloud-agent/tools-aws";
import type { AwsReadPort, ResourceDetail } from "@cloud-agent/tools-aws";
import { createHash } from "node:crypto";
import { createLimiter } from "./limit.js";

/** Stable digest of a configuration summary; volatile counters (approximate*) are excluded. */
export function configDigest(summary: Record<string, unknown>): string {
  const stable = Object.entries(summary)
    .filter(([k, v]) => !k.startsWith("approximate") && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

export interface DiscoveryOptions {
  now?: Date;
  /** Hard cap on described resources per run; the remainder is reported as a gap. */
  maxResources?: number;
  concurrency?: number;
  graphStore?: GraphStore;
}

interface Candidate {
  id: string;
  arn?: string;
  physicalId: string;
  type: string;
  logicalId?: string;
  stack?: string;
  tags: Record<string, string>;
}

export class ScopeMismatchError extends Error {}

export async function discoverSystem(
  profile: ConnectionProfile,
  port: AwsReadPort,
  evidence: EvidenceStore,
  opts: DiscoveryOptions = {},
): Promise<SystemGraph> {
  const now = opts.now ?? new Date();
  const maxResources = opts.maxResources ?? 500;
  if (port.context.accountId !== profile.accountId || port.context.region !== profile.region) {
    throw new ScopeMismatchError(
      `credentials resolve to ${port.context.accountId}/${port.context.region}, connection is ${profile.accountId}/${profile.region}`,
    );
  }
  const gaps: string[] = [];
  const ctx = port.context;
  const candidates = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    const prev = candidates.get(c.id);
    if (!prev) return void candidates.set(c.id, c);
    const stack = prev.stack ?? c.stack;
    candidates.set(c.id, { ...prev, tags: { ...prev.tags, ...c.tags }, ...(stack && { stack }) });
  };

  for (const stack of profile.scope.stacks) {
    try {
      for (const r of await port.listStackResources(stack)) {
        const arn = arnFor(r.type, r.physicalId, ctx);
        add({
          id: arn ?? `cfn:${stack}/${r.logicalId}`,
          ...(arn && { arn }),
          physicalId: r.physicalId,
          type: r.type,
          logicalId: r.logicalId,
          stack,
          tags: {},
        });
      }
    } catch (e) {
      if (e instanceof AccessDeniedError)
        gaps.push(`stack ${stack}: ${e.message}; stack members not discovered`);
      else throw e;
    }
  }
  for (const t of profile.scope.tags) {
    try {
      for (const r of await port.listResourcesByTag(t.key, t.value)) {
        add({
          id: r.arn,
          arn: r.arn,
          physicalId: physicalIdFromArn(r.arn, ctx),
          type: typeFromArn(r.arn),
          tags: r.tags,
        });
      }
    } catch (e) {
      if (e instanceof AccessDeniedError)
        gaps.push(`tag ${t.key}=${t.value}: ${e.message}; tagged resources not discovered`);
      else throw e;
    }
  }
  for (const arn of profile.scope.resourceArns) {
    add({
      id: arn,
      arn,
      physicalId: physicalIdFromArn(arn, ctx),
      type: typeFromArn(arn),
      tags: {},
    });
  }

  // Enforce scope on every candidate; nothing outside the approved selectors is described.
  let inScope = [...candidates.values()].filter(
    (c) =>
      evaluateScope(profile, {
        ...(c.arn && { arn: c.arn }),
        ...(c.stack && { stack: c.stack }),
        tags: c.tags,
      }).allowed,
  );
  const dropped = candidates.size - inScope.length;
  if (dropped)
    gaps.push(`${dropped} resource(s) outside the approved scope or account/region were ignored`);
  if (inScope.length > maxResources) {
    gaps.push(
      `discovery budget reached: ${inScope.length - maxResources} resource(s) beyond ${maxResources} were not described`,
    );
    inScope = inScope.slice(0, maxResources);
  }

  const limit = createLimiter(opts.concurrency ?? 5);
  const details = new Map<string, { detail?: ResourceDetail; obsId: string }>();
  await Promise.all(
    inScope.map((c) =>
      limit(async () => {
        const target = { arn: c.arn ?? c.id, physicalId: c.physicalId, type: c.type };
        try {
          const detail = await port.describeResource(target);
          // env values stay local to this run: only the redaction-safe fields are persisted
          const persistable = {
            summary: detail.summary,
            links: detail.links,
            limitations: detail.limitations,
          };
          const obs = await evidence.record(
            {
              source: `aws:describe:${c.type}`,
              resource: c.id,
              limitations: detail.limitations,
              confidence: detail.limitations.length ? "medium" : "high",
            },
            persistable,
            now,
          );
          details.set(c.id, { detail, obsId: obs.id });
        } catch (e) {
          if (!(e instanceof AccessDeniedError)) throw e;
          const obs = await evidence.record(
            {
              source: `aws:describe:${c.type}`,
              resource: c.id,
              confidence: "low",
              limitations: [e.message],
            },
            { error: e.message },
            now,
          );
          details.set(c.id, { obsId: obs.id });
          gaps.push(`${c.id}: ${e.message}; configuration and edges unknown`);
        }
      }),
    ),
  );

  const resources: GraphResource[] = inScope.map((c) => ({
    ...(Object.keys(details.get(c.id)?.detail?.summary ?? {}).length && {
      configDigest: configDigest(details.get(c.id)!.detail!.summary),
    }),
    id: c.id,
    ...(c.arn && { arn: c.arn }),
    type: c.type,
    ...(c.logicalId && { logicalId: c.logicalId }),
    ...(c.stack && { stack: c.stack }),
    tags: c.tags,
    provenance: "discovery",
    observedAt: now.toISOString(),
  }));
  const byArn = new Map(inScope.flatMap((c) => (c.arn ? [[c.arn, c.id] as const] : [])));
  const edges: GraphEdge[] = [];
  const edgeKey = (a: string, b: string, k: string) => `${a}|${b}|${k}`;
  const seen = new Set<string>();

  for (const c of inScope) {
    const d = details.get(c.id);
    for (const l of d?.detail?.links ?? []) {
      const from = byArn.get(l.from);
      const to = byArn.get(l.to);
      if (!from || !to) {
        gaps.push(
          `${c.id}: ${l.kind} link to ${l.to} not followed (target outside the approved scope)`,
        );
        continue;
      }
      const key = edgeKey(from, to, l.kind);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from,
        to,
        kind: l.kind,
        provenance: "discovery",
        evidence: [d!.obsId],
        rationale: l.rationale,
      });
    }
  }

  // Inferred edges: an env var whose value equals a known resource identifier. Values are matched, never stored.
  const identifiers = new Map<string, Candidate>();
  for (const c of inScope)
    for (const k of [c.arn, c.physicalId]) if (k && k.length > 3) identifiers.set(k, c);
  for (const c of inScope) {
    const d = details.get(c.id);
    for (const [name, value] of Object.entries(d?.detail?.envValues ?? {})) {
      const target = identifiers.get(value);
      if (!target || target.id === c.id) continue;
      if ([...seen].some((k) => k.startsWith(`${c.id}|${target.id}|`))) continue;
      seen.add(edgeKey(c.id, target.id, "depends-on"));
      edges.push({
        from: c.id,
        to: target.id,
        kind: "depends-on",
        provenance: "inferred",
        evidence: [d!.obsId],
        rationale: `environment variable ${name} references ${target.id}`,
      });
    }
  }

  const noDescriber = new Set<string>();
  let lambdas = 0;
  let untraced = 0;
  for (const c of inScope) {
    const d = details.get(c.id);
    if (d?.detail?.limitations.some((x) => x.startsWith("no describer"))) noDescriber.add(c.type);
    if (c.type === "AWS::Lambda::Function" && d?.detail) {
      lambdas++;
      if (d.detail.summary["tracing"] !== "Active") untraced++;
    }
    for (const lim of d?.detail?.limitations ?? [])
      if (!lim.startsWith("no describer")) gaps.push(`${c.id}: ${lim}`);
  }
  if (noDescriber.size)
    gaps.push(
      `resource types listed without configuration or edges: ${[...noDescriber].sort().join(", ")}`,
    );
  if (untraced)
    gaps.push(
      `${untraced}/${lambdas} Lambda function(s) have X-Ray active tracing disabled; trace-based answers are limited`,
    );

  const graph = SystemGraph.parse({
    systemId: profile.systemId,
    environment: profile.environment,
    accountId: profile.accountId,
    region: profile.region,
    builtAt: now.toISOString(),
    resources,
    edges,
    gaps: [...new Set(gaps)],
  });
  await opts.graphStore?.save(graph);
  return graph;
}
