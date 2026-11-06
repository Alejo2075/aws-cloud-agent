export interface TimeRange {
  start: Date;
  end: Date;
}

export interface ObservedResource {
  id: string;
  arn: string;
  type: string;
  physicalId: string;
}

export interface MetricRequest {
  resource: ObservedResource;
  metric: string;
  stat?: string;
  periodSeconds?: number;
  range: TimeRange;
}

export interface MetricSeries {
  namespace: string;
  metric: string;
  dimensions: Record<string, string>;
  stat: string;
  periodSeconds: number;
  points: Array<{ t: string; v: number }>;
  summary: { count: number; min?: number; max?: number; avg?: number; sum?: number };
}

export interface LogQuery {
  resource: ObservedResource;
  filterPattern?: string;
  range: TimeRange;
  limit: number;
  /** false → only counts are returned (no message content). */
  includeMessages: boolean;
}

export interface LogEvidence {
  logGroup: string;
  matched: number;
  truncated: boolean;
  events: Array<{ timestamp: string; message: string }>;
}

export interface DeploymentRecord {
  at: string;
  source: "cloudformation" | "cloudtrail";
  summary: string;
  stack?: string;
  resource?: string;
  actor?: string;
}

export interface CostQuery {
  tag: { key: string; value: string };
  range: TimeRange;
  granularity: "DAILY" | "MONTHLY";
}

export interface CostResult {
  total: number;
  unit: string;
  byService: Array<{ service: string; amount: number }>;
  caveats: string[];
}

/** Read-only telemetry surface. Every method is bounded by ranges and limits enforced by validators below. */
export interface ObservabilityPort {
  queryMetrics(req: MetricRequest): Promise<MetricSeries>;
  searchLogs(req: LogQuery): Promise<LogEvidence>;
  deploymentHistory(stacks: string[], range: TimeRange): Promise<DeploymentRecord[]>;
  resourceChanges(resourceName: string, range: TimeRange): Promise<DeploymentRecord[]>;
  costByTag(req: CostQuery): Promise<CostResult>;
  /** Alarms currently in ALARM state whose metric dimensions reference one of the given resources. */
  activeAlarms(resources: ObservedResource[]): Promise<ActiveAlarm[]>;
}

export interface ActiveAlarm {
  name: string;
  reason: string;
  resourceId: string;
  since?: string;
}

export const MAX_RANGE_MS = 7 * 24 * 3600 * 1000;
export const MAX_LOG_EVENTS = 50;
export const MAX_POINTS = 1440;

export class BoundsError extends Error {}

export function validateRange(r: TimeRange, now: Date, maxMs = MAX_RANGE_MS): void {
  if (!(r.start < r.end)) throw new BoundsError("time range start must be before end");
  if (r.end.getTime() > now.getTime() + 60_000)
    throw new BoundsError("time range ends in the future");
  if (r.end.getTime() - r.start.getTime() > maxMs)
    throw new BoundsError(`time range exceeds the ${maxMs / 3600000}h limit`);
}

export function choosePeriod(range: TimeRange, requested?: number): number {
  const spanSec = (range.end.getTime() - range.start.getTime()) / 1000;
  const min = Math.ceil(spanSec / MAX_POINTS / 60) * 60;
  return Math.max(60, requested ?? 0, min);
}

interface MetricSpec {
  namespace: string;
  dimension: string;
  value(r: ObservedResource): string;
  metrics: string[];
}
const lastSegment = (s: string) => s.split(/[/:]/).pop() ?? s;
export const METRIC_CATALOG: Record<string, MetricSpec> = {
  "AWS::Lambda::Function": {
    namespace: "AWS/Lambda",
    dimension: "FunctionName",
    value: (r) => r.physicalId,
    metrics: ["Invocations", "Errors", "Throttles", "Duration", "ConcurrentExecutions"],
  },
  "AWS::ApiGatewayV2::Api": {
    namespace: "AWS/ApiGateway",
    dimension: "ApiId",
    value: (r) => r.physicalId,
    metrics: ["Count", "4xx", "5xx", "Latency", "IntegrationLatency"],
  },
  "AWS::SQS::Queue": {
    namespace: "AWS/SQS",
    dimension: "QueueName",
    value: (r) => lastSegment(r.physicalId),
    metrics: [
      "ApproximateNumberOfMessagesVisible",
      "ApproximateAgeOfOldestMessage",
      "NumberOfMessagesSent",
      "NumberOfMessagesDeleted",
    ],
  },
  "AWS::DynamoDB::Table": {
    namespace: "AWS/DynamoDB",
    dimension: "TableName",
    value: (r) => r.physicalId,
    metrics: [
      "ConsumedReadCapacityUnits",
      "ConsumedWriteCapacityUnits",
      "ThrottledRequests",
      "SystemErrors",
      "UserErrors",
    ],
  },
  "AWS::SNS::Topic": {
    namespace: "AWS/SNS",
    dimension: "TopicName",
    value: (r) => lastSegment(r.arn),
    metrics: ["NumberOfMessagesPublished", "NumberOfNotificationsFailed"],
  },
  "AWS::Events::Rule": {
    namespace: "AWS/Events",
    dimension: "RuleName",
    value: (r) => lastSegment(r.arn),
    metrics: ["Invocations", "FailedInvocations"],
  },
};

export const ALLOWED_STATS = new Set([
  "Sum",
  "Average",
  "Maximum",
  "Minimum",
  "SampleCount",
  "p50",
  "p90",
  "p99",
]);

export function metricSpecFor(type: string, metric: string, stat: string) {
  const spec = METRIC_CATALOG[type];
  if (!spec) throw new BoundsError(`no metric catalog for ${type}`);
  if (!spec.metrics.includes(metric))
    throw new BoundsError(
      `metric ${metric} is not allowed for ${type}; allowed: ${spec.metrics.join(", ")}`,
    );
  if (!ALLOWED_STATS.has(stat)) throw new BoundsError(`statistic ${stat} is not allowed`);
  return spec;
}

export function lambdaLogGroup(r: ObservedResource): string {
  if (r.type !== "AWS::Lambda::Function")
    throw new BoundsError("log search is limited to Lambda functions in scope");
  return `/aws/lambda/${r.physicalId}`;
}
