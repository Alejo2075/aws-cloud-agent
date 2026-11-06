import { z } from "zod";
import type { Observation, SystemGraph } from "@cloud-agent/contracts";
import type { EvidenceStore } from "@cloud-agent/evidence";
import { findResource, impactOf, neighbors, summarize } from "@cloud-agent/graph";
import { freshness } from "@cloud-agent/evidence";
import type { ObservabilityPort } from "@cloud-agent/tools-aws";
import type { RepoReader } from "@cloud-agent/tools-git";

export interface ToolPolicy {
  sensitiveDataAccess: boolean;
  costDataAccess: boolean;
  /** Tag selector usable for cost attribution, if the connection has one. */
  costTag?: { key: string; value: string };
}

export interface ToolContext {
  graph: SystemGraph;
  evidence: EvidenceStore;
  now: Date;
  policy: ToolPolicy;
  observability?: ObservabilityPort;
  repo?: RepoReader;
}

export interface ToolResult {
  /** Text shown to the model; always wrapped as untrusted by the orchestrator. */
  data: unknown;
  /** Observations whose ids the model may cite. */
  observations: Observation[];
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** Only "read" tools exist in the ask path; the orchestrator rejects anything else. */
  access: "read";
  input: S;
  run(ctx: ToolContext, input: z.infer<S>): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(t: AgentTool<S>): AgentTool<S> {
  return t;
}

async function observationsFor(ctx: ToolContext, resourceId: string) {
  return (await ctx.evidence.list()).filter((o) => o.resource === resourceId);
}

export const systemOverview = defineTool({
  name: "get_system_overview",
  description:
    "Summary of the discovered system: resource counts by type, edge counts, discovery time, freshness and known gaps.",
  access: "read",
  input: z.object({}),
  async run(ctx) {
    return {
      data: {
        ...summarize(ctx.graph),
        freshness: freshness(ctx.graph.builtAt, ctx.now),
        accountId: ctx.graph.accountId,
        region: ctx.graph.region,
      },
      observations: [],
    };
  },
});

export const listResources = defineTool({
  name: "list_resources",
  description:
    "List discovered resources, optionally filtered by CloudFormation type (e.g. AWS::Lambda::Function).",
  access: "read",
  input: z.object({ type: z.string().optional() }),
  async run(ctx, input) {
    const rs = ctx.graph.resources.filter((r) => !input.type || r.type === input.type);
    return {
      data: rs.map((r) => ({ id: r.id, type: r.type, logicalId: r.logicalId, stack: r.stack })),
      observations: [],
    };
  },
});

export const getResourceDetails = defineTool({
  name: "get_resource_details",
  description:
    "Configuration summary, relationships and evidence for one resource, by ARN, id or CloudFormation logical id.",
  access: "read",
  input: z.object({ resource: z.string().min(1) }),
  async run(ctx, input) {
    const r = findResource(ctx.graph, input.resource);
    if (!r) return { data: { error: `no resource matches ${input.resource}` }, observations: [] };
    const observations = await observationsFor(ctx, r.id);
    const payloads = await Promise.all(
      observations.map((o) => ctx.evidence.getPayload(o.evidenceRef)),
    );
    return {
      data: {
        resource: r,
        observationIds: observations.map((o) => o.id),
        configuration: payloads,
        relationships: neighbors(ctx.graph, r.id),
        freshness: freshness(r.observedAt, ctx.now),
      },
      observations,
    };
  },
});

export const getDependencies = defineTool({
  name: "get_dependencies",
  description:
    "Direct upstream (incoming) and downstream (outgoing) relationships of a resource, each with provenance (discovery or inferred).",
  access: "read",
  input: z.object({ resource: z.string().min(1) }),
  async run(ctx, input) {
    const r = findResource(ctx.graph, input.resource);
    if (!r) return { data: { error: `no resource matches ${input.resource}` }, observations: [] };
    const n = neighbors(ctx.graph, r.id);
    const ids = new Set([...n.incoming, ...n.outgoing].flatMap((e) => e.evidence));
    const observations = (await ctx.evidence.list()).filter((o) => ids.has(o.id));
    return { data: n, observations };
  },
});

export const getImpact = defineTool({
  name: "get_impact",
  description:
    "Resources that could be affected if the given resource were removed or failed (transitive upstream walk). Inferred paths are flagged.",
  access: "read",
  input: z.object({ resource: z.string().min(1) }),
  async run(ctx, input) {
    const r = findResource(ctx.graph, input.resource);
    if (!r) return { data: { error: `no resource matches ${input.resource}` }, observations: [] };
    const hits = impactOf(ctx.graph, r.id);
    const ids = new Set(hits.flatMap((h) => h.via.evidence));
    return {
      data: { resource: r.id, potentiallyAffected: hits },
      observations: (await ctx.evidence.list()).filter((o) => ids.has(o.id)),
    };
  },
});

export const graphTools = [
  systemOverview,
  listResources,
  getResourceDetails,
  getDependencies,
  getImpact,
] as AgentTool[];
