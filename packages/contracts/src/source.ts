import { z } from "zod";

export const SourceRef = z.object({
  resourceId: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  kind: z.enum(["iac-definition", "handler-source"]),
  revision: z.string().optional(),
  /** How the mapping was made; mappings are heuristic and carry confidence. */
  basis: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const IacKind = z.enum(["aws-cdk", "aws-sam", "cloudformation", "terraform", "unknown"]);
export type IacKind = z.infer<typeof IacKind>;
