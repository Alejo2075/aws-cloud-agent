import type { ChangePlan, Verifier } from "@cloud-agent/changes";

type Criterion = ChangePlan["verification"][number];
type MetricCheck = NonNullable<Criterion["check"]>;

/** Structural subset of the observability surface, so this package does not depend on tools-aws. */
export interface MetricSource {
  resolve(resourceId: string): { id: string } | undefined;
  query(
    resourceId: string,
    check: MetricCheck,
    range: { start: Date; end: Date },
  ): Promise<{
    summary: { count: number; min?: number; max?: number; avg?: number; sum?: number };
  }>;
}

const PICK = {
  Average: "avg",
  Sum: "sum",
  Minimum: "min",
  Maximum: "max",
} as const;

function compare(c: MetricCheck["comparator"], v: number, t: number): boolean {
  return c === "lt" ? v < t : c === "lte" ? v <= t : c === "gt" ? v > t : v >= t;
}

/**
 * Evaluates `metric` criteria against recent telemetry. It fails closed: no data, an unresolvable
 * resource or a query error all count as "not verified". Other criteria are delegated unchanged.
 */
export function createMetricVerifier(deps: {
  source: MetricSource;
  now: () => Date;
  rest: Verifier;
}): Verifier {
  return {
    async verify(plan) {
      const delegated = await deps.rest.verify({
        ...plan,
        verification: plan.verification.filter((v) => !v.check),
      });
      const out: Awaited<ReturnType<Verifier["verify"]>> = [];
      for (const v of plan.verification) {
        const c = v.check;
        if (!c) {
          const d = delegated.find((x) => x.id === v.id);
          if (d) out.push(d);
          continue;
        }
        if (!deps.source.resolve(c.resourceId)) {
          out.push({ id: v.id, passed: false, detail: `no in-scope resource ${c.resourceId}` });
          continue;
        }
        const end = deps.now();
        const range = { start: new Date(end.getTime() - c.windowMinutes * 60_000), end };
        try {
          const { summary } = await deps.source.query(c.resourceId, c, range);
          const value = summary[PICK[c.stat]];
          if (summary.count === 0 || value === undefined) {
            out.push({
              id: v.id,
              passed: false,
              detail: `no ${c.metric} datapoints in the last ${c.windowMinutes} minutes; cannot verify`,
            });
            continue;
          }
          const ok = compare(c.comparator, value, c.threshold);
          out.push({
            id: v.id,
            passed: ok,
            detail: `${c.metric} ${c.stat} = ${value} over ${c.windowMinutes}m (${summary.count} points); required ${c.comparator} ${c.threshold}`,
          });
        } catch (e) {
          out.push({
            id: v.id,
            passed: false,
            detail: `metric query failed: ${(e as Error).message}`,
          });
        }
      }
      return out;
    },
  };
}
