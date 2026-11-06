export type Freshness = "fresh" | "stale" | "unknown";

export const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

/** Observations older than maxAge are never presented as current production truth. */
export function freshness(
  observedAt: string | undefined,
  now: Date,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): Freshness {
  if (!observedAt) return "unknown";
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return "unknown";
  return now.getTime() - t <= maxAgeMs ? "fresh" : "stale";
}
