import { arnFor } from "@cloud-agent/tools-aws";
import type {
  AwsReadPort,
  DescribeTarget,
  ResourceDetail,
  StackResource,
} from "@cloud-agent/tools-aws";

/** In-memory AwsReadPort used by tests and offline demos. It never talks to AWS. */
export class FakeAwsReadPort implements AwsReadPort {
  constructor(
    readonly context: { accountId: string; region: string },
    private readonly stacks: Record<string, StackResource[]>,
    private readonly details: Record<string, ResourceDetail | Error> = {},
    private readonly tagged: Record<
      string,
      Array<{ arn: string; tags: Record<string, string> }>
    > = {},
    readonly stackStatuses: Record<string, string> = {},
  ) {}
  async getStackStatus(stack: string) {
    return this.stackStatuses[stack] ?? "UPDATE_COMPLETE";
  }
  async listStackResources(stack: string) {
    const s = this.stacks[stack];
    if (!s) throw new Error(`no such stack ${stack}`);
    return s;
  }
  async listResourcesByTag(key: string, value: string) {
    return this.tagged[`${key}=${value}`] ?? [];
  }
  async describeResource(t: DescribeTarget) {
    const d = this.details[t.arn];
    if (d instanceof Error) throw d;
    return (
      d ?? {
        summary: {},
        links: [],
        limitations: [`no describer for ${t.type}; listed without configuration or edges`],
      }
    );
  }
}

const ctx = { accountId: "123456789012", region: "us-east-1" };
const res = (logicalId: string, type: string, physicalId: string): StackResource => ({
  stack: "restaurant-app-prod",
  logicalId,
  physicalId,
  type,
  status: "CREATE_COMPLETE",
});
export const restaurantStack: StackResource[] = [
  res("ReservationsApi", "AWS::ApiGatewayV2::Api", "abc123"),
  res("CreateReservationFn", "AWS::Lambda::Function", "create-reservation"),
  res("ConfirmFn", "AWS::Lambda::Function", "confirm-reservation"),
  res("ReservationsTable", "AWS::DynamoDB::Table", "reservations"),
  res(
    "ConfirmQueue",
    "AWS::SQS::Queue",
    "https://sqs.us-east-1.amazonaws.com/123456789012/confirm-queue",
  ),
  res(
    "ConfirmDlq",
    "AWS::SQS::Queue",
    "https://sqs.us-east-1.amazonaws.com/123456789012/confirm-dlq",
  ),
  res("FnRole", "AWS::IAM::Role", "restaurant-fn-role"),
];
const a = (t: string, p: string) => arnFor(t, p, ctx)!;
export const A = {
  api: a("AWS::ApiGatewayV2::Api", "abc123"),
  create: a("AWS::Lambda::Function", "create-reservation"),
  confirm: a("AWS::Lambda::Function", "confirm-reservation"),
  table: a("AWS::DynamoDB::Table", "reservations"),
  queue: a("AWS::SQS::Queue", "https://sqs.us-east-1.amazonaws.com/123456789012/confirm-queue"),
  dlq: a("AWS::SQS::Queue", "https://sqs.us-east-1.amazonaws.com/123456789012/confirm-dlq"),
};
export function restaurantPort(overrides: Record<string, ResourceDetail | Error> = {}) {
  return new FakeAwsReadPort(
    ctx,
    { "restaurant-app-prod": restaurantStack },
    {
      [A.api]: {
        summary: { name: "reservations" },
        limitations: [],
        links: [{ from: A.api, to: A.create, kind: "invokes", rationale: "integration i1" }],
      },
      [A.create]: {
        summary: { tracing: "PassThrough" },
        limitations: [],
        links: [
          {
            from: A.create,
            to: "arn:aws:lambda:us-east-1:123456789012:function:not-in-scope",
            kind: "invokes",
            rationale: "x",
          },
        ],
        envValues: {
          TABLE: "reservations",
          QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/confirm-queue",
          STAGE: "prod",
        },
      },
      [A.confirm]: {
        summary: { tracing: "Active" },
        limitations: [],
        links: [
          {
            from: A.confirm,
            to: A.queue,
            kind: "subscribes-to",
            rationale: "event source mapping u1 (Enabled)",
          },
        ],
      },
      [A.table]: { summary: { billingMode: "PAY_PER_REQUEST" }, limitations: [], links: [] },
      [A.queue]: {
        summary: {},
        limitations: [],
        links: [
          {
            from: A.queue,
            to: A.dlq,
            kind: "writes-to",
            rationale: "redrive policy dead-letter queue",
          },
        ],
      },
      [A.dlq]: { summary: {}, limitations: [], links: [] },
      ...overrides,
    },
  );
}
