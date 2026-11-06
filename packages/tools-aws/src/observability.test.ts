import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudFormationClient, DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import {
  AccessDeniedError,
  BoundsError,
  SdkObservabilityPort,
  choosePeriod,
  validateRange,
} from "./index.js";

const cw = mockClient(CloudWatchClient);
const logs = mockClient(CloudWatchLogsClient);
const cfn = mockClient(CloudFormationClient);
const trail = mockClient(CloudTrailClient);
const ce = mockClient(CostExplorerClient);
const port = new SdkObservabilityPort("us-east-1");
const fn = {
  id: "f",
  arn: "arn:aws:lambda:us-east-1:123456789012:function:checkout",
  type: "AWS::Lambda::Function",
  physicalId: "checkout",
};
const range = { start: new Date("2026-11-06T10:00:00Z"), end: new Date("2026-11-06T11:00:00Z") };

beforeEach(() => [cw, logs, cfn, trail, ce].forEach((m) => m.reset()));

describe("bounds", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  it("rejects inverted, future and oversized ranges", () => {
    expect(() => validateRange({ start: range.end, end: range.start }, now)).toThrow(BoundsError);
    expect(() =>
      validateRange({ start: range.start, end: new Date("2026-11-07T00:00:00Z") }, now),
    ).toThrow("future");
    expect(() => validateRange({ start: new Date("2026-10-01T00:00:00Z"), end: now }, now)).toThrow(
      "limit",
    );
    expect(() => validateRange(range, now)).not.toThrow();
  });
  it("widens the period so a range never exceeds 1440 points", () => {
    expect(choosePeriod(range)).toBe(60);
    expect(
      choosePeriod({
        start: new Date("2026-11-01T00:00:00Z"),
        end: new Date("2026-11-06T00:00:00Z"),
      }),
    ).toBeGreaterThanOrEqual(300);
  });
});

describe("SdkObservabilityPort", () => {
  it("queries an allowlisted metric and summarizes", async () => {
    cw.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        {
          Id: "m1",
          Timestamps: [new Date("2026-11-06T10:00:00Z"), new Date("2026-11-06T10:01:00Z")],
          Values: [1, 5],
        },
      ],
    });
    const s = await port.queryMetrics({ resource: fn, metric: "Errors", range });
    expect(s.dimensions).toEqual({ FunctionName: "checkout" });
    expect(s.summary).toMatchObject({ count: 2, max: 5, sum: 6 });
  });
  it("rejects metrics and stats outside the allowlist before any API call", async () => {
    await expect(
      port.queryMetrics({ resource: fn, metric: "SomethingElse", range }),
    ).rejects.toThrow("not allowed");
    await expect(
      port.queryMetrics({ resource: fn, metric: "Errors", stat: "Evil", range }),
    ).rejects.toThrow("not allowed");
    expect(cw.calls()).toHaveLength(0);
  });
  it("maps denial to AccessDeniedError", async () => {
    cw.on(GetMetricDataCommand).rejects(Object.assign(new Error("x"), { name: "AccessDenied" }));
    await expect(
      port.queryMetrics({ resource: fn, metric: "Errors", range }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
  it("returns only counts unless messages are explicitly allowed, and caps messages", async () => {
    logs.on(FilterLogEventsCommand).resolves({
      events: Array.from({ length: 80 }, (_, i) => ({ timestamp: i, message: `error ${i}` })),
    });
    const counts = await port.searchLogs({
      resource: fn,
      range,
      limit: 10,
      includeMessages: false,
    });
    expect(counts).toMatchObject({ logGroup: "/aws/lambda/checkout", matched: 80, events: [] });
    const withMsgs = await port.searchLogs({
      resource: fn,
      range,
      limit: 500,
      includeMessages: true,
    });
    expect(withMsgs.events).toHaveLength(50);
    expect(withMsgs.truncated).toBe(true);
  });
  it("limits log search to Lambda functions", async () => {
    await expect(
      port.searchLogs({
        resource: { ...fn, type: "AWS::SQS::Queue" },
        range,
        limit: 5,
        includeMessages: false,
      }),
    ).rejects.toThrow("limited to Lambda");
  });
  it("lists stack-level deployment events inside the range only", async () => {
    cfn.on(DescribeStackEventsCommand).resolves({
      StackEvents: [
        {
          StackId: "s",
          EventId: "1",
          StackName: "app",
          Timestamp: new Date("2026-11-06T10:30:00Z"),
          ResourceType: "AWS::CloudFormation::Stack",
          LogicalResourceId: "app",
          ResourceStatus: "UPDATE_COMPLETE",
        },
        {
          StackId: "s",
          EventId: "2",
          StackName: "app",
          Timestamp: new Date("2026-11-06T10:20:00Z"),
          ResourceType: "AWS::Lambda::Function",
          LogicalResourceId: "Fn",
          ResourceStatus: "UPDATE_COMPLETE",
        },
        {
          StackId: "s",
          EventId: "3",
          StackName: "app",
          Timestamp: new Date("2026-11-01T10:00:00Z"),
          ResourceType: "AWS::CloudFormation::Stack",
          LogicalResourceId: "app",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ],
    });
    const d = await port.deploymentHistory(["app"], range);
    expect(d.map((x) => x.summary)).toEqual(["UPDATE_COMPLETE"]);
  });
  it("keeps only mutating CloudTrail events", async () => {
    trail.on(LookupEventsCommand).resolves({
      Events: [
        {
          EventName: "UpdateFunctionCode20150331v2",
          EventSource: "lambda.amazonaws.com",
          EventTime: new Date("2026-11-06T10:10:00Z"),
          Username: "deployer",
        },
        { EventName: "GetFunction", EventTime: new Date("2026-11-06T10:11:00Z") },
      ],
    });
    const c = await port.resourceChanges("checkout", range);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ actor: "deployer", source: "cloudtrail" });
  });
  it("aggregates tag-scoped cost by service with caveats", async () => {
    ce.on(GetCostAndUsageCommand).resolves({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "1.5", Unit: "USD" } } },
            { Keys: ["Amazon DynamoDB"], Metrics: { UnblendedCost: { Amount: "3", Unit: "USD" } } },
          ],
        },
        {
          Groups: [
            { Keys: ["AWS Lambda"], Metrics: { UnblendedCost: { Amount: "0.5", Unit: "USD" } } },
          ],
        },
      ],
    });
    const r = await port.costByTag({
      tag: { key: "system", value: "x" },
      range: { start: new Date("2026-10-01"), end: new Date("2026-11-01") },
      granularity: "MONTHLY",
    });
    expect(r).toMatchObject({
      total: 5,
      unit: "USD",
      byService: [
        { service: "Amazon DynamoDB", amount: 3 },
        { service: "AWS Lambda", amount: 2 },
      ],
    });
    expect(r.caveats.join()).toContain("untagged");
  });
});

describe("activeAlarms", () => {
  const dims = (name: string, value: string) => [{ Name: name, Value: value }];
  it("matches exact dimension name and value only, including metric-math alarms", async () => {
    const { DescribeAlarmsCommand } = await import("@aws-sdk/client-cloudwatch");
    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [
        {
          AlarmName: "checkout-errors",
          StateReason: "Threshold crossed",
          Dimensions: dims("FunctionName", "checkout"),
          StateUpdatedTimestamp: new Date("2026-11-06T10:00:00Z"),
        },
        { AlarmName: "other-team", Dimensions: dims("FunctionName", "someone-elses") },
        { AlarmName: "wrong-dimension", Dimensions: dims("TableName", "checkout") },
        { AlarmName: "by-arn", Dimensions: dims("arn", fn.arn) },
        {
          AlarmName: "metric-math",
          Metrics: [
            {
              Id: "m",
              MetricStat: {
                Metric: {
                  Namespace: "AWS/Lambda",
                  MetricName: "Errors",
                  Dimensions: dims("FunctionName", "checkout"),
                },
                Period: 60,
                Stat: "Sum",
              },
            },
          ],
        },
      ],
    });
    const a = await port.activeAlarms([fn]);
    expect(a.map((x) => x.name)).toEqual(["checkout-errors", "by-arn", "metric-math"]);
    expect(a[0]).toMatchObject({ resourceId: "f", since: "2026-11-06T10:00:00.000Z" });
  });
  it("treats firing composite alarms as blocking because they cannot be mapped to a resource", async () => {
    const { DescribeAlarmsCommand } = await import("@aws-sdk/client-cloudwatch");
    cw.on(DescribeAlarmsCommand).resolves({
      MetricAlarms: [],
      CompositeAlarms: [
        { AlarmName: "site-down", AlarmRule: "ALARM(a)", StateReason: "child alarm fired" },
      ],
    });
    const a = await port.activeAlarms([fn]);
    expect(a).toEqual([expect.objectContaining({ name: "site-down", resourceId: "unknown" })]);
  });
  it("fails closed when the alarm listing is cut off", async () => {
    const { DescribeAlarmsCommand } = await import("@aws-sdk/client-cloudwatch");
    cw.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [], NextToken: "more" });
    const a = await port.activeAlarms([fn]);
    expect(a.at(-1)).toMatchObject({ name: "(listing incomplete)" });
  });
});
