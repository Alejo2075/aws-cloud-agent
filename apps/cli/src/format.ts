import type { EvidenceBackedAnswer, SystemGraph } from "@cloud-agent/contracts";
import { freshness } from "@cloud-agent/evidence";

export function formatAnswer(a: EvidenceBackedAnswer): string {
  const lines = [a.answer, ""];
  if (a.observations.length) {
    lines.push("Observations (evidence):");
    for (const o of a.observations)
      lines.push(
        `  - ${o.id}  ${o.source}${o.resource ? `  ${o.resource}` : ""}  observed ${o.observedAt}  [${o.confidence}]`,
      );
  } else lines.push("Observations: none cited");
  if (a.hypotheses.length)
    lines.push("", "Hypotheses (not confirmed):", ...a.hypotheses.map((h) => `  - ${h}`));
  if (a.limitations.length) lines.push("", "Limitations:", ...a.limitations.map((l) => `  - ${l}`));
  return lines.join("\n");
}

export function formatGraph(g: SystemGraph, now: Date): string {
  const lines = [
    `System ${g.systemId} / ${g.environment}  account ${g.accountId}  ${g.region}`,
    `Discovered ${g.builtAt} (${freshness(g.builtAt, now)})  ${g.resources.length} resources, ${g.edges.length} relationships`,
    "",
    "Resources:",
    ...g.resources.map((r) => `  ${r.type.padEnd(28)} ${r.logicalId ?? ""}  ${r.arn ?? r.id}`),
    "",
    "Relationships:",
    ...(g.edges.length
      ? g.edges.map(
          (e) =>
            `  ${e.from}\n    --${e.kind}--> ${e.to}   [${e.provenance}${e.rationale ? `: ${e.rationale}` : ""}]`,
        )
      : ["  none discovered"]),
  ];
  if (g.gaps.length) lines.push("", "Gaps and limitations:", ...g.gaps.map((x) => `  - ${x}`));
  return lines.join("\n");
}
