import { z } from "zod";
import { wrapUntrusted } from "@cloud-agent/evidence";
import { findResource } from "@cloud-agent/graph";
import {
  AccessDeniedError,
  BoundsError,
  physicalIdFromArn,
  validateRange,
} from "@cloud-agent/tools-aws";
import type { ObservedResource, TimeRange } from "@cloud-agent/tools-aws";
import { defineTool } from "./tools.js";
import type { AgentTool, ToolContext, ToolResult } from "./tools.js";

const hoursBack = z.number().int().min(1).max(168).default(1);

function rangeFor(ctx: ToolContext, hours: number): TimeRange {
  const range = { start: new Date(ctx.now.getTime() - hours * 3600_000), end: ctx.now };
  validateRange(range, ctx.now);
  return range;
}

function observed(ctx: ToolContext, ref: string): ObservedResource | string {
  const r = findResource(ctx.graph, ref);
  if (!r?.arn) return `no in-scope resource with an ARN matches ${ref}`;
  return { id: r.id, arn: r.arn, type: r.type, physicalId: physicalIdFromArn(r.arn, ctx.graph) };
}

/** Convert expected operational failures into tool output plus a low-confidence observation. */
async function guarded(
  ctx: ToolContext,
  source: string,
  resource: string | undefined,
  timeRange: string,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!ctx.observability)
    return {
      data: { error: "no observability access is configured for this connection" },
      observations: [],
    };
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AccessDeniedError || e instanceof BoundsError) {
      const obs = await ctx.evidence.record(
        {
          source,
          ...(resource && { resource }),
          timeRange,
          confidence: "low",
          limitations: [e.message],
        },
        { error: e.message },
        ctx.now,
      );
      return {
        data: {
          error: e.message,
          note: "this data source could not be read; do not infer its contents",
        },
        observations: [obs],
      };
    }
    throw e;
  }
}

const iso = (r: TimeRange) => `${r.start.toISOString()}/${r.end.toISOString()}`;

export const queryMetrics = defineTool({
  name: "query_metrics",
  description:
    "CloudWatch metric for one in-scope resource over the last N hours (max 168). Lambda: Invocations, Errors, Throttles, Duration. HTTP API: Count, 4xx, 5xx, Latency. SQS, DynamoDB, SNS, EventBridge rules have catalogs too.",
  access: "read",
  input: z.object({
    resource: z.string().min(1),
    metric: z.string().min(1),
    stat: z.string().default("Sum"),
    hoursBack,
  }),
  async run(ctx, input) {
    const res = observed(ctx, input.resource);
    if (typeof res === "string") return { data: { error: res }, observations: [] };
    const range = rangeFor(ctx, input.hoursBack);
    return guarded(ctx, "CloudWatchMetrics", res.id, iso(range), async () => {
      const series = await ctx.observability!.queryMetrics({
        resource: res,
        metric: input.metric,
        stat: input.stat,
        range,
      });
      const step = Math.ceil(series.points.length / 48) || 1;
      const obs = await ctx.evidence.record(
        {
          source: "CloudWatchMetrics",
          resource: res.id,
          timeRange: iso(range),
          limitations: series.points.length
            ? []
            : ["no datapoints returned (no traffic, or metric not emitted)"],
        },
        series,
        ctx.now,
      );
      return {
        data: {
          observationId: obs.id,
          ...series,
          points: series.points.filter((_, i) => i % step === 0),
        },
        observations: [obs],
      };
    });
  },
});

export const searchLogs = defineTool({
  name: "search_logs",
  description:
    "Search a Lambda function's CloudWatch log group (last N hours, max 168). Returns match counts always; message text only when the connection allows sensitive data access.",
  access: "read",
  input: z.object({
    resource: z.string().min(1),
    filterPattern: z.string().max(200).optional(),
    hoursBack,
  }),
  async run(ctx, input) {
    const res = observed(ctx, input.resource);
    if (typeof res === "string") return { data: { error: res }, observations: [] };
    const range = rangeFor(ctx, input.hoursBack);
    return guarded(ctx, "CloudWatchLogs", res.id, iso(range), async () => {
      const ev = await ctx.observability!.searchLogs({
        resource: res,
        ...(input.filterPattern && { filterPattern: input.filterPattern }),
        range,
        limit: 20,
        includeMessages: ctx.policy.sensitiveDataAccess,
      });
      const limitations = ctx.policy.sensitiveDataAccess
        ? []
        : [
            "log message content withheld: this connection does not allow sensitive data access; only match counts are available",
          ];
      const obs = await ctx.evidence.record(
        {
          source: "CloudWatchLogs",
          resource: res.id,
          timeRange: iso(range),
          limitations,
          confidence: ctx.policy.sensitiveDataAccess ? "high" : "medium",
        },
        ev,
        ctx.now,
      );
      return {
        data: {
          observationId: obs.id,
          logGroup: ev.logGroup,
          matched: ev.matched,
          truncated: ev.truncated,
          limitations,
          messages: wrapUntrusted(
            `logs:${ev.logGroup}`,
            ev.events.map((e) => `${e.timestamp} ${e.message}`).join("\n"),
          ),
        },
        observations: [obs],
      };
    });
  },
});

export const getDeploymentHistory = defineTool({
  name: "get_deployment_history",
  description:
    "Stack-level CloudFormation events and (optionally for one resource) mutating CloudTrail events in the last N hours. Use to see what changed before a symptom; correlation is not causation.",
  access: "read",
  input: z.object({ resource: z.string().optional(), hoursBack: hoursBack.default(24) }),
  async run(ctx, input) {
    const range = rangeFor(ctx, input.hoursBack);
    const stacks = [...new Set(ctx.graph.resources.flatMap((r) => (r.stack ? [r.stack] : [])))];
    let target: ObservedResource | undefined;
    if (input.resource) {
      const res = observed(ctx, input.resource);
      if (typeof res === "string") return { data: { error: res }, observations: [] };
      target = res;
    }
    return guarded(ctx, "DeploymentHistory", target?.id, iso(range), async () => {
      const cfn = await ctx.observability!.deploymentHistory(stacks, range);
      const trail = target
        ? await ctx.observability!.resourceChanges(target.physicalId, range)
        : [];
      const records = [...cfn, ...trail].sort((a, b) => a.at.localeCompare(b.at));
      const obs = await ctx.evidence.record(
        {
          source: "DeploymentHistory",
          ...(target && { resource: target.id }),
          timeRange: iso(range),
          limitations: stacks.length
            ? []
            : ["no CloudFormation stacks in scope; only CloudTrail changes for the named resource"],
        },
        records,
        ctx.now,
      );
      return { data: { observationId: obs.id, records }, observations: [obs] };
    });
  },
});

export const getCost = defineTool({
  name: "get_cost",
  description:
    "Cost Explorer cost for resources carrying the connection's scope tag, between two dates (YYYY-MM-DD). Excludes shared and untagged costs.",
  access: "read",
  input: z.object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    granularity: z.enum(["DAILY", "MONTHLY"]).default("MONTHLY"),
  }),
  async run(ctx, input) {
    if (!ctx.policy.costDataAccess)
      return {
        data: { error: "cost data access is not enabled for this connection" },
        observations: [],
      };
    if (!ctx.policy.costTag)
      return {
        data: {
          error:
            "cost attribution needs a tag selector in the connection scope; costs cannot be tied to this system otherwise",
        },
        observations: [],
      };
    const range = {
      start: new Date(`${input.startDate}T00:00:00Z`),
      end: new Date(`${input.endDate}T00:00:00Z`),
    };
    validateRange(range, new Date(ctx.now.getTime() + 86400_000), 366 * 86400_000);
    return guarded(ctx, "CostExplorer", undefined, iso(range), async () => {
      const r = await ctx.observability!.costByTag({
        tag: ctx.policy.costTag!,
        range,
        granularity: input.granularity,
      });
      const obs = await ctx.evidence.record(
        { source: "CostExplorer", timeRange: iso(range), limitations: r.caveats },
        r,
        ctx.now,
      );
      return { data: { observationId: obs.id, ...r }, observations: [obs] };
    });
  },
});

export const opsTools = [queryMetrics, searchLogs, getDeploymentHistory, getCost] as AgentTool[];
