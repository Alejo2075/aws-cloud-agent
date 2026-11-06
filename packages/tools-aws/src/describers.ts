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
import { DescribeStateMachineCommand } from "@aws-sdk/client-sfn";
import { DescribeStreamSummaryCommand } from "@aws-sdk/client-kinesis";
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

interface AslState {
  Type?: string;
  Resource?: string;
  Parameters?: Record<string, unknown>;
  Branches?: Array<{ States?: Record<string, AslState> }>;
  ItemProcessor?: { States?: Record<string, AslState> };
  Iterator?: { States?: Record<string, AslState> };
}

function* walkStates(states: Record<string, AslState> | undefined): Generator<AslState> {
  for (const st of Object.values(states ?? {})) {
    yield st;
    for (const b of st.Branches ?? []) yield* walkStates(b.States);
    yield* walkStates(st.ItemProcessor?.States);
    yield* walkStates(st.Iterator?.States);
  }
}

const lambdaArn = (v: string, region: string, account: string) => {
  const m = /^(arn:aws:lambda:[^:]+:\d+:function:[^:]+)/.exec(v);
  if (m) return m[1];
  return /^[\w-]{1,64}$/.test(v) ? `arn:aws:lambda:${region}:${account}:function:${v}` : undefined;
};

export async function describeStateMachine(
  c: AwsClients,
  t: DescribeTarget,
): Promise<ResourceDetail> {
  const limitations: string[] = [];
  let sm;
  try {
    sm = await c.sfn.send(new DescribeStateMachineCommand({ stateMachineArn: t.arn }));
  } catch (e) {
    if (isAccessDenied(e)) throw new AccessDeniedError("states:DescribeStateMachine", e);
    throw e;
  }
  const [, , , region = "", account = ""] = t.arn.split(":");
  const links: ResourceLink[] = [];
  let dynamic = 0;
  let def: { States?: Record<string, AslState> } = {};
  try {
    def = JSON.parse(sm.definition ?? "{}");
  } catch {
    limitations.push("state machine definition was not valid JSON; relationships unknown");
  }
  for (const st of walkStates(def.States)) {
    if (st.Type !== "Task" || !st.Resource) continue;
    const p = st.Parameters ?? {};
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    const hasDynamic = Object.keys(p).some((k) => k.endsWith(".$"));
    const add = (to: string | undefined, kind: ResourceLink["kind"], why: string) =>
      to ? links.push(...link(t.arn, to, kind, why)) : hasDynamic && dynamic++;
    const r = st.Resource;
    if (r.startsWith("arn:aws:lambda:"))
      add(lambdaArn(r, region, account), "invokes", "state machine task");
    else if (r === "arn:aws:states:::lambda:invoke")
      add(lambdaArn(str("FunctionName") ?? "", region, account), "invokes", "lambda:invoke task");
    else if (r.startsWith("arn:aws:states:::sqs:")) {
      const url = str("QueueUrl");
      const name = url?.split("/").pop();
      add(
        url && name ? `arn:aws:sqs:${region}:${url.split("/")[3] ?? account}:${name}` : undefined,
        "publishes-to",
        "sqs task",
      );
    } else if (r.startsWith("arn:aws:states:::sns:"))
      add(str("TopicArn"), "publishes-to", "sns:publish task");
    else if (r.startsWith("arn:aws:states:::dynamodb:")) {
      const table = str("TableName");
      add(
        table ? `arn:aws:dynamodb:${region}:${account}:table/${table}` : undefined,
        r.endsWith(":getItem") ? "reads-from" : "writes-to",
        `${r.split(":::")[1] ?? "dynamodb"} task`,
      );
    } else if (r.startsWith("arn:aws:states:::states:startExecution"))
      add(str("StateMachineArn"), "invokes", "nested execution");
    else if (!r.startsWith("arn:aws:states:::")) add(undefined, "invokes", "");
    else limitations.push(`task integration ${r} is not graphed`);
  }
  if (dynamic)
    limitations.push(
      `${dynamic} task target(s) are computed at runtime (.$ parameters) and cannot be graphed`,
    );
  return {
    summary: {
      type: sm.type,
      status: sm.status,
      roleArn: sm.roleArn,
      tracing: sm.tracingConfiguration?.enabled ? "Active" : "Disabled",
      loggingLevel: sm.loggingConfiguration?.level,
    },
    links,
    limitations: [...new Set(limitations)],
  };
}

export async function describeStream(c: AwsClients, t: DescribeTarget): Promise<ResourceDetail> {
  let s;
  try {
    s = (await c.kinesis.send(new DescribeStreamSummaryCommand({ StreamName: t.physicalId })))
      .StreamDescriptionSummary;
  } catch (e) {
    if (isAccessDenied(e)) throw new AccessDeniedError("kinesis:DescribeStreamSummary", e);
    throw e;
  }
  return {
    summary: {
      mode: s?.StreamModeDetails?.StreamMode,
      openShards: s?.OpenShardCount,
      retentionHours: s?.RetentionPeriodHours,
      encryption: s?.EncryptionType,
    },
    links: [],
    limitations: [],
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
  "AWS::StepFunctions::StateMachine": describeStateMachine,
  "AWS::Kinesis::Stream": describeStream,
};
