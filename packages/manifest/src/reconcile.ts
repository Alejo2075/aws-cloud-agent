import type { SystemGraph } from "@cloud-agent/contracts";
import type { CloudSystemManifest } from "./schema.js";

export interface Reconciliation {
  source: "imported-manifest";
  environment: string;
  accountMatches: boolean;
  regionMatches: boolean;
  confirmed: Array<{ logicalId: string; type: string; resourceId: string }>;
  /** In the manifest but not found live: stale or removed. Never presented as existing. */
  missing: Array<{ logicalId: string; type: string }>;
  typeMismatches: Array<{ logicalId: string; manifestType: string; liveType: string }>;
  /** Live resources the manifest did not declare. */
  unexpected: Array<{ resourceId: string; type: string }>;
  notes: string[];
}

/** Compare a manifest hint to current live discovery; live observations win every disagreement. */
export function reconcileManifest(
  manifest: CloudSystemManifest,
  environment: string,
  graph: SystemGraph,
): Reconciliation {
  const env = manifest.environments.find((e) => e.name === environment);
  if (!env) throw new Error(`manifest has no environment ${environment}`);
  const live = graph.resources.filter((r) => r.logicalId);
  const confirmed: Reconciliation["confirmed"] = [];
  const missing: Reconciliation["missing"] = [];
  const typeMismatches: Reconciliation["typeMismatches"] = [];
  for (const m of env.resources) {
    const hit = live.find((r) => r.logicalId === m.logicalId);
    if (!hit) missing.push(m);
    else if (hit.type !== m.type)
      typeMismatches.push({ logicalId: m.logicalId, manifestType: m.type, liveType: hit.type });
    else confirmed.push({ ...m, resourceId: hit.id });
  }
  const declared = new Set(env.resources.map((r) => r.logicalId));
  const unexpected = live
    .filter((r) => !declared.has(r.logicalId!))
    .map((r) => ({ resourceId: r.id, type: r.type }));
  const notes: string[] = [];
  const stacksMissing = env.stacks.filter((s) => !graph.resources.some((r) => r.stack === s));
  if (stacksMissing.length)
    notes.push(`stacks declared but not observed: ${stacksMissing.join(", ")}`);
  if (manifest.deployment?.verifiedAt)
    notes.push(
      `manifest verifiedAt ${manifest.deployment.verifiedAt} is a claim, not an observation`,
    );
  return {
    source: "imported-manifest",
    environment,
    accountMatches: env.accountId === graph.accountId,
    regionMatches: env.region === graph.region,
    confirmed,
    missing,
    typeMismatches,
    unexpected,
    notes,
  };
}

/** Scope selectors implied by a manifest environment; roles must still be supplied by the user. */
export function scopeFromManifest(manifest: CloudSystemManifest, environment: string) {
  const env = manifest.environments.find((e) => e.name === environment);
  if (!env || !env.stacks.length)
    throw new Error(`manifest environment ${environment} declares no stacks`);
  return {
    systemId: manifest.system.id,
    environment: env.name,
    accountId: env.accountId,
    region: env.region,
    scope: { stacks: env.stacks },
  };
}
