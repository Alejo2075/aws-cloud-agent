import { z } from "zod";
import { Provenance } from "./evidence.js";

export const RelationshipKind = z.enum([
  "invokes",
  "publishes-to",
  "subscribes-to",
  "reads-from",
  "writes-to",
  "depends-on",
  "exposes",
  "deployed-by",
]);
export type RelationshipKind = z.infer<typeof RelationshipKind>;

export const GraphResource = z.object({
  /** ARN when known; otherwise a stable synthetic id such as cfn:<stack>/<logicalId>. */
  id: z.string().min(1),
  arn: z.string().startsWith("arn:").optional(),
  type: z.string().min(1),
  logicalId: z.string().optional(),
  stack: z.string().optional(),
  tags: z.record(z.string(), z.string()).default({}),
  /** Digest of the stable configuration summary; a change between discoveries signals configuration drift. */
  configDigest: z.string().optional(),
  provenance: Provenance,
  observedAt: z.iso.datetime(),
});
export type GraphResource = z.infer<typeof GraphResource>;

export const GraphEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: RelationshipKind,
  provenance: Provenance,
  /** Observation ids supporting the edge; inferred edges may have none but must say why. */
  evidence: z.array(z.string()).default([]),
  rationale: z.string().optional(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const SystemGraph = z.object({
  systemId: z.string().min(1),
  environment: z.string().min(1),
  accountId: z.string(),
  region: z.string(),
  builtAt: z.iso.datetime(),
  resources: z.array(GraphResource),
  edges: z.array(GraphEdge),
  gaps: z.array(z.string()),
});
export type SystemGraph = z.infer<typeof SystemGraph>;
