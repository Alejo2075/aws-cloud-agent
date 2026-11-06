import { z } from "zod";

export const Provenance = z.enum(["discovery", "imported-manifest", "inferred"]);
export type Provenance = z.infer<typeof Provenance>;

export const Observation = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  resource: z.string().min(1).optional(),
  observedAt: z.iso.datetime(),
  timeRange: z.string().optional(),
  evidenceRef: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  limitations: z.array(z.string()).default([]),
});
export type Observation = z.infer<typeof Observation>;

/** Answers separate facts, hypotheses and limits; missing access is a first-class state. */
export const EvidenceBackedAnswer = z.object({
  answer: z.string(),
  observations: z.array(Observation),
  hypotheses: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type EvidenceBackedAnswer = z.infer<typeof EvidenceBackedAnswer>;
