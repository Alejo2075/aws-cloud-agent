import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudFormationClient, DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { isAccessDenied } from "./describers.js";
import { AccessDeniedError } from "./port.js";
import {
  BoundsError,
  MAX_LOG_EVENTS,
  choosePeriod,
  lambdaLogGroup,
  metricSpecFor,
} from "./observability.js";
import type {
  CostQuery,
  CostResult,
  DeploymentRecord,
  LogEvidence,
  LogQuery,
  MetricRequest,
  MetricSeries,
  ObservabilityPort,
  TimeRange,
} from "./observability.js";

const denied = <T>(op: string, fn: () => Promise<T>) =>
  fn().catch((e) => {
    throw isAccessDenied(e) ? new AccessDeniedError(op, e) : e;
  });

export class SdkObservabilityPort implements ObservabilityPort {
  private readonly cw: CloudWatchClient;
  private readonly logs: CloudWatchLogsClient;
  private readonly cfn: CloudFormationClient;
  private readonly trail: CloudTrailClient;
  private readonly ce: CostExplorerClient;

  constructor(region: string, credentials?: AwsCredentialIdentityProvider) {
    const cfg = { region, ...(credentials && { credentials }), maxAttempts: 4 };
    this.cw = new CloudWatchClient(cfg);
    this.logs = new CloudWatchLogsClient(cfg);
    this.cfn = new CloudFormationClient(cfg);
    this.trail = new CloudTrailClient(cfg);
    // Cost Explorer is a global service served from us-east-1.
    this.ce = new CostExplorerClient({ ...cfg, region: "us-east-1" });
  }

  async queryMetrics(req: MetricRequest): Promise<MetricSeries> {
    const stat = req.stat ?? "Sum";
    const spec = metricSpecFor(req.resource.type, req.metric, stat);
    const period = choosePeriod(req.range, req.periodSeconds);
    const dims = { [spec.dimension]: spec.value(req.resource) };
    const points: MetricSeries["points"] = [];
    let token: string | undefined;
    await denied("cloudwatch:GetMetricData", async () => {
      do {
        const r = await this.cw.send(
          new GetMetricDataCommand({
            StartTime: req.range.start,
            EndTime: req.range.end,
            ScanBy: "TimestampAscending",
            MetricDataQueries: [
              {
                Id: "m1",
                ReturnData: true,
                MetricStat: {
                  Period: period,
                  Stat: stat,
                  Metric: {
                    Namespace: spec.namespace,
                    MetricName: req.metric,
                    Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })),
                  },
                },
              },
            ],
            ...(token && { NextToken: token }),
          }),
        );
        const res = r.MetricDataResults?.[0];
        (res?.Timestamps ?? []).forEach((t, i) =>
          points.push({ t: t.toISOString(), v: res?.Values?.[i] ?? 0 }),
        );
        token = r.NextToken;
      } while (token && points.length < 1440);
    });
    const vs = points.map((p) => p.v);
    const sum = vs.reduce((a, b) => a + b, 0);
    return {
      namespace: spec.namespace,
      metric: req.metric,
      dimensions: dims,
      stat,
      periodSeconds: period,
      points,
      summary: vs.length
        ? {
            count: vs.length,
            min: Math.min(...vs),
            max: Math.max(...vs),
            avg: sum / vs.length,
            sum,
          }
        : { count: 0 },
    };
  }

  async searchLogs(req: LogQuery): Promise<LogEvidence> {
    const logGroup = lambdaLogGroup(req.resource);
    const limit = Math.min(req.limit, MAX_LOG_EVENTS);
    const events: LogEvidence["events"] = [];
    let matched = 0;
    let token: string | undefined;
    let pages = 0;
    await denied("logs:FilterLogEvents", async () => {
      do {
        const r = await this.logs.send(
          new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: req.range.start.getTime(),
            endTime: req.range.end.getTime(),
            ...(req.filterPattern && { filterPattern: req.filterPattern }),
            limit: 100,
            ...(token && { nextToken: token }),
          }),
        );
        for (const e of r.events ?? []) {
          matched++;
          if (req.includeMessages && events.length < limit)
            events.push({
              timestamp: new Date(e.timestamp ?? 0).toISOString(),
              message: (e.message ?? "").slice(0, 600),
            });
        }
        token = r.nextToken;
      } while (token && ++pages < 5);
    });
    return {
      logGroup,
      matched,
      truncated: !!token || (req.includeMessages && matched > events.length),
      events,
    };
  }

  async deploymentHistory(stacks: string[], range: TimeRange): Promise<DeploymentRecord[]> {
    const out: DeploymentRecord[] = [];
    for (const stack of stacks) {
      let token: string | undefined;
      let reachedOlder = false;
      let pages = 0;
      await denied("cloudformation:DescribeStackEvents", async () => {
        do {
          const r = await this.cfn.send(
            new DescribeStackEventsCommand({
              StackName: stack,
              ...(token && { NextToken: token }),
            }),
          );
          for (const e of r.StackEvents ?? []) {
            const at = e.Timestamp;
            if (!at) continue;
            if (at < range.start) {
              reachedOlder = true;
              break;
            }
            if (
              at <= range.end &&
              e.ResourceType === "AWS::CloudFormation::Stack" &&
              e.LogicalResourceId === stack
            ) {
              out.push({
                at: at.toISOString(),
                source: "cloudformation",
                stack,
                summary: `${e.ResourceStatus}${e.ResourceStatusReason ? `: ${e.ResourceStatusReason}` : ""}`,
              });
            }
          }
          token = r.NextToken;
        } while (token && !reachedOlder && ++pages < 10);
      });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async resourceChanges(resourceName: string, range: TimeRange): Promise<DeploymentRecord[]> {
    const out: DeploymentRecord[] = [];
    let token: string | undefined;
    let pages = 0;
    await denied("cloudtrail:LookupEvents", async () => {
      do {
        const r = await this.trail.send(
          new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: resourceName }],
            StartTime: range.start,
            EndTime: range.end,
            MaxResults: 50,
            ...(token && { NextToken: token }),
          }),
        );
        for (const e of r.Events ?? []) {
          if (!e.EventName || /^(Get|List|Describe|Head)/.test(e.EventName)) continue;
          out.push({
            at: (e.EventTime ?? new Date(0)).toISOString(),
            source: "cloudtrail",
            resource: resourceName,
            summary: `${e.EventSource ?? ""} ${e.EventName}`.trim(),
            ...(e.Username && { actor: e.Username }),
          });
        }
        token = r.NextToken;
      } while (token && ++pages < 3);
    });
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async costByTag(req: CostQuery): Promise<CostResult> {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if (day(req.range.start) === day(req.range.end))
      throw new BoundsError("cost range must span at least one day");
    const r = await denied("ce:GetCostAndUsage", () =>
      this.ce.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: day(req.range.start), End: day(req.range.end) },
          Granularity: req.granularity,
          Metrics: ["UnblendedCost"],
          Filter: { Tags: { Key: req.tag.key, Values: [req.tag.value] } },
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        }),
      ),
    );
    const by = new Map<string, number>();
    let unit = "USD";
    for (const period of r.ResultsByTime ?? []) {
      for (const g of period.Groups ?? []) {
        const m = g.Metrics?.["UnblendedCost"];
        unit = m?.Unit ?? unit;
        by.set(
          g.Keys?.[0] ?? "unknown",
          (by.get(g.Keys?.[0] ?? "unknown") ?? 0) + Number(m?.Amount ?? 0),
        );
      }
    }
    const byService = [...by]
      .map(([service, amount]) => ({ service, amount }))
      .sort((a, b) => b.amount - a.amount);
    return {
      total: byService.reduce((a, b) => a + b.amount, 0),
      unit,
      byService,
      caveats: [
        `Only costs carrying tag ${req.tag.key}=${req.tag.value} (requires an activated cost allocation tag); shared or untagged costs are excluded.`,
        "Cost Explorer data can lag by up to 24 hours.",
      ],
    };
  }
}
