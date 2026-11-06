import { createHash } from "node:crypto";
import type { GraphEdge, GraphResource, SystemGraph } from "@cloud-agent/contracts";

export function findResource(
  graph: SystemGraph,
  idOrArnOrLogical: string,
): GraphResource | undefined {
  return graph.resources.find(
    (r) =>
      r.id === idOrArnOrLogical || r.arn === idOrArnOrLogical || r.logicalId === idOrArnOrLogical,
  );
}

export function neighbors(graph: SystemGraph, id: string) {
  return {
    outgoing: graph.edges.filter((e) => e.from === id),
    incoming: graph.edges.filter((e) => e.to === id),
  };
}

/**
 * Resources that may be affected if `id` is removed or breaks: everything that reaches it through
 * edges (transitively). Each hit records the path edge so the answer can cite provenance.
 * Inferred edges are flagged so callers can state lower confidence.
 */
export function impactOf(graph: SystemGraph, id: string) {
  const seen = new Map<string, { via: GraphEdge; hasInferred: boolean }>();
  const queue: Array<{ id: string; inferred: boolean }> = [{ id, inferred: false }];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of graph.edges.filter((x) => x.to === cur.id)) {
      if (e.from === id || seen.has(e.from)) continue;
      const inferred = cur.inferred || e.provenance === "inferred";
      seen.set(e.from, { via: e, hasInferred: inferred });
      queue.push({ id: e.from, inferred });
    }
  }
  return [...seen.entries()].map(([rid, v]) => ({ resourceId: rid, ...v }));
}

export function summarize(graph: SystemGraph) {
  const byType: Record<string, number> = {};
  for (const r of graph.resources) byType[r.type] = (byType[r.type] ?? 0) + 1;
  return {
    systemId: graph.systemId,
    environment: graph.environment,
    builtAt: graph.builtAt,
    resourceCount: graph.resources.length,
    edgeCount: graph.edges.length,
    inferredEdgeCount: graph.edges.filter((e) => e.provenance === "inferred").length,
    byType,
    gaps: graph.gaps,
  };
}

/** Topology fingerprint (resource ids, types, edges). Configuration-level drift is not covered. */
export function fingerprintGraph(graph: SystemGraph): string {
  const rs = graph.resources.map((r) => `${r.id}|${r.type}`).sort();
  const es = graph.edges.map((e) => `${e.from}|${e.kind}|${e.to}`).sort();
  return createHash("sha256")
    .update(JSON.stringify([rs, es]))
    .digest("hex");
}
