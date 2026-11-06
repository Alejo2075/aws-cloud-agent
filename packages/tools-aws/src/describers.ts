import {
  GetIntegrationsCommand,
  GetRoutesCommand,
  GetApiCommand,
} from "@aws-sdk/client-apigatewayv2";
import { DescribeRuleCommand, ListTargetsByRuleCommand } from "@aws-sdk/client-eventbridge";
import {
  GetFunctionConfigurationCommand,
  ListEventSourceMappingsCommand,
} from "@aws-sdk/client-lambda";
import { DescribeContinuousBackupsCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { GetBucketNotificationConfigurationCommand } from "@aws-sdk/client-s3";
import { GetTopicAttributesCommand, ListSubscriptionsByTopicCommand } from "@aws-sdk/client-sns";
import { normalizeTargetArn } from "./arn.js";
import type { AwsClients } from "./clients.js";
import { AccessDeniedError } from "./port.js";
import type { DescribeTarget, ResourceDetail, ResourceLink } from "./port.js";

const DENIED = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "UnauthorizedOperation",
  "AuthorizationError",
  "Forbidden",
]);

export function isAccessDenied(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return DENIED.has(err?.name ?? "") || err?.$metadata?.httpStatusCode === 403;
}

/** Run one optional enrichment call; permission failures become limitations rather than crashes. */
async function optional<T>(op: string, limitations: string[], fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (isAccessDenied(e)) {
      limitations.push(`${op}: access denied`);
      return undefined;
    }
    throw e;
  }
}

const link = (
  from: string,
  to: string | undefined,
  kind: ResourceLink["kind"],
  rationale: string,
): ResourceLink[] => (to ? [{ from, to: normalizeTargetArn(to), kind, rationale }] : []);

export async function describeLambda(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  const limitations: string[] = [];
  let cfg;
  try {
    cfg = await c.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: t.physicalId }));
  } catch (e) {
    if (isAccessDenied(e)) throw new AccessDeniedError("lambda:GetFunctionConfiguration", e);
    throw e;
  }
  const links: ResourceLink[] = [];
  const mappings = await optional("lambda:ListEventSourceMappings", limitations, async () => {
    const out = [];
    let marker: string | undefined;
    do {
      const r = await c.lambda.send(
        new ListEventSourceMappingsCommand({
          FunctionName: t.physicalId,
          ...(marker && { Marker: marker }),
        }),
      );
      out.push(...(r.EventSourceMappings ?? []));
      marker = r.NextMarker;
    } while (marker);
    return out;
  });
  for (const m of mappings ?? []) {
    links.push(
      ...link(
        t.arn,
        m.EventSourceArn,
        "subscribes-to",
        `event source mapping ${m.UUID ?? ""} (${m.State ?? "unknown"})`,
      ),
    );
  }
  links.push(
    ...link(t.arn, cfg.DeadLetterConfig?.TargetArn, "writes-to", "function dead-letter target"),
  );
  const envValues = cfg.Environment?.Variables ?? {};
  return {
    summary: {
      runtime: cfg.Runtime,
      handler: cfg.Handler,
      timeoutSeconds: cfg.Timeout,
      memoryMb: cfg.MemorySize,
      roleArn: cfg.Role,
      architectures: cfg.Architectures,
      tracing: cfg.TracingConfig?.Mode,
      envVarNames: Object.keys(envValues),
      codeSha256: cfg.CodeSha256,
      lastModified: cfg.LastModified,
      eventSourceMappings: mappings?.length,
    },
    links,
    envValues,
    limitations,
  };
}

export async function describeApi(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  const limitations: string[] = [];
  const api = await c.apigw.send(new GetApiCommand({ ApiId: t.physicalId }));
  const links: ResourceLink[] = [];
  const integrations = await optional("apigateway:GetIntegrations", limitations, async () => {
    const out = [];
    let token: string | undefined;
    do {
      const r = await c.apigw.send(
        new GetIntegrationsCommand({ ApiId: t.physicalId, ...(token && { NextToken: token }) }),
      );
      out.push(...(r.Items ?? []));
      token = r.NextToken;
    } while (token);
    return out;
  });
  const external: string[] = [];
  for (const i of integrations ?? []) {
    const uri = i.IntegrationUri ?? "";
    const arn = /(arn:aws:lambda:[^/]+:function:[^/:]+(?::[^/]+)?)/.exec(uri)?.[1];
    if (arn)
      links.push(
        ...link(
          t.arn,
          arn,
          "invokes",
          `integration ${i.IntegrationId ?? ""} (${i.IntegrationType ?? ""})`,
        ),
      );
    else if (uri.startsWith("arn:"))
      links.push(...link(t.arn, uri, "invokes", `integration ${i.IntegrationId ?? ""}`));
    else if (uri) external.push(new URL(uri, "https://invalid.local").host);
  }
  const routes = await optional("apigateway:GetRoutes", limitations, async () => {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await c.apigw.send(
        new GetRoutesCommand({ ApiId: t.physicalId, ...(token && { NextToken: token }) }),
      );
      out.push(...(r.Items ?? []).map((x) => x.RouteKey ?? ""));
      token = r.NextToken;
    } while (token);
    return out;
  });
  if (external.length)
    limitations.push(`non-AWS integration hosts not graphed: ${[...new Set(external)].join(", ")}`);
  return {
    summary: { name: api.Name, protocol: api.ProtocolType, endpoint: api.ApiEndpoint, routes },
    links,
    limitations,
  };
}

export async function describeRule(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  const limitations: string[] = [];
  const id = t.physicalId.includes("|") ? t.physicalId.split("|") : [undefined, t.physicalId];
  const bus = id[0];
  const name = id[1] ?? t.physicalId;
  const rule = await c.events.send(
    new DescribeRuleCommand({ Name: name, ...(bus && { EventBusName: bus }) }),
  );
  const targets = await optional("events:ListTargetsByRule", limitations, async () => {
    const r = await c.events.send(
      new ListTargetsByRuleCommand({ Rule: name, ...(bus && { EventBusName: bus }) }),
    );
    return r.Targets ?? [];
  });
  const links = (targets ?? []).flatMap((x) =>
    link(t.arn, x.Arn, "publishes-to", `rule target ${x.Id ?? ""}`),
  );
  return {
    summary: {
      state: rule.State,
      schedule: rule.ScheduleExpression,
      hasEventPattern: !!rule.EventPattern,
      eventPattern: rule.EventPattern,
      bus: rule.EventBusName,
    },
    links,
    limitations,
  };
}

export async function describeTopic(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  const limitations: string[] = [];
  const attrs = await optional("sns:GetTopicAttributes", limitations, () =>
    c.sns.send(new GetTopicAttributesCommand({ TopicArn: t.arn })),
  );
  const subs = await optional("sns:ListSubscriptionsByTopic", limitations, async () => {
    const out = [];
    let token: string | undefined;
    do {
      const r = await c.sns.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: t.arn,
          ...(token && { NextToken: token }),
        }),
      );
      out.push(...(r.Subscriptions ?? []));
      token = r.NextToken;
    } while (token);
    return out;
  });
  const links = (subs ?? []).flatMap((s) =>
    s.Endpoint?.startsWith("arn:")
      ? link(t.arn, s.Endpoint, "publishes-to", `${s.Protocol ?? ""} subscription`)
      : [],
  );
  const nonArn = (subs ?? []).filter((s) => !s.Endpoint?.startsWith("arn:")).length;
  if (nonArn)
    limitations.push(
      `${nonArn} subscription(s) with non-ARN endpoints (email/http/sms) not graphed`,
    );
  return {
    summary: {
      subscriptionsConfirmed: attrs?.Attributes?.["SubscriptionsConfirmed"],
      fifo: attrs?.Attributes?.["FifoTopic"],
    },
    links,
    limitations,
  };
}

export async function describeBucket(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  const limitations: string[] = [];
  const bucket = t.physicalId;
  const n = await optional("s3:GetBucketNotification", limitations, () =>
    c.s3.send(new GetBucketNotificationConfigurationCommand({ Bucket: bucket })),
  );
  const links = [
    ...(n?.LambdaFunctionConfigurations ?? []).flatMap((x) =>
      link(t.arn, x.LambdaFunctionArn, "publishes-to", "bucket notification"),
    ),
    ...(n?.QueueConfigurations ?? []).flatMap((x) =>
      link(t.arn, x.QueueArn, "publishes-to", "bucket notification"),
    ),
    ...(n?.TopicConfigurations ?? []).flatMap((x) =>
      link(t.arn, x.TopicArn, "publishes-to", "bucket notification"),
    ),
  ];
  return { summary: { bucket, notificationTargets: links.length }, links, limitations };
}

export async function describeTable(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  const limitations: string[] = [];
  let r;
  try {
    r = await c.dynamodb.send(new DescribeTableCommand({ TableName: t.physicalId }));
  } catch (e) {
    if (isAccessDenied(e)) throw new AccessDeniedError("dynamodb:DescribeTable", e);
    throw e;
  }
  const tbl = r.Table;
  const backups = await optional("dynamodb:DescribeContinuousBackups", limitations, () =>
    c.dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: t.physicalId })),
  );
  return {
    summary: {
      keySchema: tbl?.KeySchema,
      billingMode: tbl?.BillingModeSummary?.BillingMode ?? "PROVISIONED",
      approximateItemCount: tbl?.ItemCount,
      streamEnabled: !!tbl?.StreamSpecification?.StreamEnabled,
      globalSecondaryIndexes: tbl?.GlobalSecondaryIndexes?.map((g) => g.IndexName),
      pointInTimeRecovery:
        backups?.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
          ?.PointInTimeRecoveryStatus,
      deletionProtection: tbl?.DeletionProtectionEnabled,
    },
    links: [],
    limitations,
  };
}

export async function describeQueue(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  const limitations: string[] = [];
  let attrs: Record<string, string> | undefined;
  try {
    attrs = (
      await c.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: t.physicalId, AttributeNames: ["All"] }),
      )
    ).Attributes;
  } catch (e) {
    if (isAccessDenied(e)) throw new AccessDeniedError("sqs:GetQueueAttributes", e);
    throw e;
  }
  let dlq: string | undefined;
  try {
    dlq = attrs?.["RedrivePolicy"]
      ? (JSON.parse(attrs["RedrivePolicy"]).deadLetterTargetArn as string)
      : undefined;
  } catch {
    limitations.push("RedrivePolicy was not valid JSON");
  }
  return {
    summary: {
      visibilityTimeoutSeconds: attrs?.["VisibilityTimeout"],
      approximateMessages: attrs?.["ApproximateNumberOfMessages"],
      approximateMessagesNotVisible: attrs?.["ApproximateNumberOfMessagesNotVisible"],
      fifo: attrs?.["FifoQueue"] === "true",
      hasDeadLetterQueue: !!dlq,
    },
    links: link(t.arn, dlq, "writes-to", "redrive policy dead-letter queue"),
    limitations,
  };
}

export const DESCRIBERS: Record<
  string,
  (c: AwsClients, t: DescribeTarget) => Promise<ResourceDetail>
> = {
  "AWS::Lambda::Function": describeLambda,
  "AWS::ApiGatewayV2::Api": describeApi,
  "AWS::Events::Rule": describeRule,
  "AWS::SNS::Topic": describeTopic,
  "AWS::S3::Bucket": describeBucket,
  "AWS::DynamoDB::Table": describeTable,
  "AWS::SQS::Queue": describeQueue,
};
