import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GetApiCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
} from "@aws-sdk/client-apigatewayv2";
import { DescribeStacksCommand, ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import {
  GetFunctionConfigurationCommand,
  ListEventSourceMappingsCommand,
} from "@aws-sdk/client-lambda";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  AccessDeniedError,
  SdkAwsReadPort,
  arnFor,
  normalizeTargetArn,
  physicalIdFromArn,
  isStackHealthy,
} from "./index.js";

const ctx = { accountId: "123456789012", region: "us-east-1" };
const lambda = mockClient(LambdaClient);
const apigw = mockClient(ApiGatewayV2Client);
const sqs = mockClient(SQSClient);
const cfn = mockClient(CloudFormationClient);
const port = new SdkAwsReadPort(ctx);

beforeEach(() => {
  lambda.reset();
  apigw.reset();
  sqs.reset();
  cfn.reset();
});

describe("arn helpers", () => {
  it("round-trips physical ids", () => {
    const arn = arnFor(
      "AWS::SQS::Queue",
      "https://sqs.us-east-1.amazonaws.com/123456789012/q",
      ctx,
    )!;
    expect(arn).toBe("arn:aws:sqs:us-east-1:123456789012:q");
    expect(physicalIdFromArn(arn, ctx)).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/q");
    expect(normalizeTargetArn("arn:aws:dynamodb:us-east-1:123456789012:table/T/stream/2026")).toBe(
      "arn:aws:dynamodb:us-east-1:123456789012:table/T",
    );
  });
});

describe("SdkAwsReadPort", () => {
  it("paginates stack resources", async () => {
    cfn
      .on(ListStackResourcesCommand)
      .resolvesOnce({
        StackResourceSummaries: [
          {
            LogicalResourceId: "A",
            PhysicalResourceId: "a",
            ResourceType: "AWS::SQS::Queue",
            ResourceStatus: "CREATE_COMPLETE",
            LastUpdatedTimestamp: new Date(),
          },
        ],
        NextToken: "t",
      })
      .resolvesOnce({
        StackResourceSummaries: [
          {
            LogicalResourceId: "B",
            PhysicalResourceId: "b",
            ResourceType: "AWS::SQS::Queue",
            ResourceStatus: "CREATE_COMPLETE",
            LastUpdatedTimestamp: new Date(),
          },
        ],
      });
    expect((await port.listStackResources("s")).map((r) => r.logicalId)).toEqual(["A", "B"]);
  });

  it("describes a Lambda, normalizing stream sources and omitting env values", async () => {
    lambda.on(GetFunctionConfigurationCommand).resolves({
      Runtime: "nodejs22.x",
      Timeout: 10,
      Environment: { Variables: { SECRET_THING: "s3cr3t" } },
    });
    lambda.on(ListEventSourceMappingsCommand).resolves({
      EventSourceMappings: [
        {
          UUID: "u1",
          State: "Enabled",
          EventSourceArn: "arn:aws:dynamodb:us-east-1:123456789012:table/T/stream/2026",
        },
      ],
    });
    const d = await port.describeResource({
      arn: "arn:aws:lambda:us-east-1:123456789012:function:f",
      physicalId: "f",
      type: "AWS::Lambda::Function",
    });
    expect(d.links[0]).toMatchObject({
      kind: "subscribes-to",
      to: "arn:aws:dynamodb:us-east-1:123456789012:table/T",
    });
    expect(JSON.stringify(d.summary)).not.toContain("s3cr3t");
    expect(d.summary["envVarNames"]).toEqual(["SECRET_THING"]);
  });

  it("degrades to a limitation when an optional call is denied", async () => {
    lambda.on(GetFunctionConfigurationCommand).resolves({ Runtime: "nodejs22.x" });
    lambda
      .on(ListEventSourceMappingsCommand)
      .rejects(Object.assign(new Error("no"), { name: "AccessDeniedException" }));
    const d = await port.describeResource({
      arn: "arn:aws:lambda:us-east-1:123456789012:function:f",
      physicalId: "f",
      type: "AWS::Lambda::Function",
    });
    expect(d.limitations).toContain("lambda:ListEventSourceMappings: access denied");
  });

  it("throws AccessDeniedError when the primary call is denied", async () => {
    lambda
      .on(GetFunctionConfigurationCommand)
      .rejects(Object.assign(new Error("no"), { name: "AccessDeniedException" }));
    await expect(
      port.describeResource({ arn: "a", physicalId: "f", type: "AWS::Lambda::Function" }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("extracts Lambda targets from HTTP API integrations", async () => {
    apigw.on(GetApiCommand).resolves({ Name: "api", ProtocolType: "HTTP" });
    apigw.on(GetIntegrationsCommand).resolves({
      Items: [
        {
          IntegrationId: "i1",
          IntegrationUri: "arn:aws:lambda:us-east-1:123456789012:function:create",
        },
        {
          IntegrationId: "i2",
          IntegrationUri:
            "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:legacy/invocations",
        },
        { IntegrationId: "i3", IntegrationUri: "https://example.com/hook" },
      ],
    });
    apigw.on(GetRoutesCommand).resolves({ Items: [{ RouteKey: "POST /reservations" }] });
    const d = await port.describeResource({
      arn: "arn:aws:apigateway:us-east-1::/apis/x",
      physicalId: "x",
      type: "AWS::ApiGatewayV2::Api",
    });
    expect(d.links.map((l) => l.to)).toEqual([
      "arn:aws:lambda:us-east-1:123456789012:function:create",
      "arn:aws:lambda:us-east-1:123456789012:function:legacy",
    ]);
    expect(d.limitations.join()).toContain("example.com");
    expect(d.summary["routes"]).toEqual(["POST /reservations"]);
  });

  it("links a queue to its dead-letter queue", async () => {
    sqs.on(GetQueueAttributesCommand).resolves({
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: "arn:aws:sqs:us-east-1:123456789012:dlq",
        }),
        VisibilityTimeout: "30",
      },
    });
    const d = await port.describeResource({
      arn: "arn:aws:sqs:us-east-1:123456789012:q",
      physicalId: "https://sqs/q",
      type: "AWS::SQS::Queue",
    });
    expect(d.links[0]).toMatchObject({
      to: "arn:aws:sqs:us-east-1:123456789012:dlq",
      kind: "writes-to",
    });
  });

  it("reports unsupported types honestly", async () => {
    const d = await port.describeResource({ arn: "x", physicalId: "x", type: "AWS::IAM::Role" });
    expect(d.limitations[0]).toContain("no describer");
  });
});

describe("stack health", () => {
  it("reads the stack status and classifies it", async () => {
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        { StackName: "s", CreationTime: new Date(), StackStatus: "UPDATE_ROLLBACK_COMPLETE" },
      ],
    });
    const status = await port.getStackStatus("s");
    expect(status).toBe("UPDATE_ROLLBACK_COMPLETE");
    expect(isStackHealthy(status)).toBe(false);
    expect(["CREATE_COMPLETE", "UPDATE_COMPLETE"].every(isStackHealthy)).toBe(true);
    expect(isStackHealthy("UPDATE_IN_PROGRESS")).toBe(false);
  });
});

describe("Step Functions and Kinesis", () => {
  it("extracts targets from a state machine, including nested states, and flags dynamic ones", async () => {
    const { mockClient: mc } = await import("aws-sdk-client-mock");
    const { SFNClient, DescribeStateMachineCommand } = await import("@aws-sdk/client-sfn");
    const sfn = mc(SFNClient);
    const definition = JSON.stringify({
      StartAt: "A",
      States: {
        A: {
          Type: "Task",
          Resource: "arn:aws:lambda:us-east-1:123456789012:function:direct:$LATEST",
          Next: "P",
        },
        P: {
          Type: "Parallel",
          Branches: [
            {
              States: {
                B: {
                  Type: "Task",
                  Resource: "arn:aws:states:::lambda:invoke",
                  Parameters: { FunctionName: "confirm-reservation" },
                },
              },
            },
            {
              States: {
                C: {
                  Type: "Task",
                  Resource: "arn:aws:states:::sqs:sendMessage",
                  Parameters: {
                    QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/confirm-queue",
                  },
                },
              },
            },
          ],
          Next: "M",
        },
        M: {
          Type: "Map",
          ItemProcessor: {
            States: {
              D: {
                Type: "Task",
                Resource: "arn:aws:states:::dynamodb:getItem",
                Parameters: { TableName: "reservations" },
              },
              E: {
                Type: "Task",
                Resource: "arn:aws:states:::sns:publish",
                Parameters: { "TopicArn.$": "$.topic" },
              },
            },
          },
        },
      },
    });
    sfn.on(DescribeStateMachineCommand).resolves({
      definition,
      type: "STANDARD",
      status: "ACTIVE",
      roleArn: "r",
      stateMachineArn: "x",
      name: "n",
      creationDate: new Date(),
    });
    const arn = "arn:aws:states:us-east-1:123456789012:stateMachine:flow";
    const d = await port.describeResource({
      arn,
      physicalId: arn,
      type: "AWS::StepFunctions::StateMachine",
    });
    expect(d.links.map((l) => `${l.kind} ${l.to}`).sort()).toEqual([
      "invokes arn:aws:lambda:us-east-1:123456789012:function:confirm-reservation",
      "invokes arn:aws:lambda:us-east-1:123456789012:function:direct",
      "publishes-to arn:aws:sqs:us-east-1:123456789012:confirm-queue",
      "reads-from arn:aws:dynamodb:us-east-1:123456789012:table/reservations",
    ]);
    expect(d.limitations.join()).toContain("computed at runtime");
  });

  it("describes a Kinesis stream and round-trips its ARN", async () => {
    const { mockClient: mc } = await import("aws-sdk-client-mock");
    const { KinesisClient, DescribeStreamSummaryCommand } = await import("@aws-sdk/client-kinesis");
    mc(KinesisClient)
      .on(DescribeStreamSummaryCommand)
      .resolves({
        StreamDescriptionSummary: {
          StreamName: "s",
          StreamARN: "a",
          StreamStatus: "ACTIVE",
          StreamCreationTimestamp: new Date(),
          RetentionPeriodHours: 24,
          OpenShardCount: 2,
          EnhancedMonitoring: [],
          StreamModeDetails: { StreamMode: "PROVISIONED" },
        },
      });
    const arn = arnFor("AWS::Kinesis::Stream", "orders", ctx)!;
    expect(arn).toBe("arn:aws:kinesis:us-east-1:123456789012:stream/orders");
    expect(physicalIdFromArn(arn, ctx)).toBe("orders");
    const d = await port.describeResource({
      arn,
      physicalId: "orders",
      type: "AWS::Kinesis::Stream",
    });
    expect(d.summary).toMatchObject({ mode: "PROVISIONED", openShards: 2, retentionHours: 24 });
  });
});

describe("REST API, ECS and RDS", () => {
  it("graphs REST API lambda integrations across pages and notes external hosts", async () => {
    const { mockClient: mc } = await import("aws-sdk-client-mock");
    const { APIGatewayClient, GetResourcesCommand, GetRestApiCommand } =
      await import("@aws-sdk/client-api-gateway");
    const gw = mc(APIGatewayClient);
    gw.on(GetRestApiCommand).resolves({
      name: "orders",
      endpointConfiguration: { types: ["REGIONAL"] },
    });
    const lambdaUri =
      "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:orders/invocations";
    gw.on(GetResourcesCommand)
      .resolvesOnce({
        position: "p2",
        items: [
          {
            path: "/orders",
            resourceMethods: { GET: { methodIntegration: { type: "AWS_PROXY", uri: lambdaUri } } },
          },
        ],
      })
      .resolvesOnce({
        items: [
          {
            path: "/ext",
            resourceMethods: {
              POST: { methodIntegration: { type: "HTTP", uri: "https://example.test/x" } },
            },
          },
        ],
      });
    const arn = arnFor("AWS::ApiGateway::RestApi", "abc123", ctx)!;
    const d = await port.describeResource({
      arn,
      physicalId: "abc123",
      type: "AWS::ApiGateway::RestApi",
    });
    expect(d.links.map((l) => l.to)).toEqual([
      "arn:aws:lambda:us-east-1:123456789012:function:orders",
    ]);
    expect(d.summary).toMatchObject({ name: "orders", routes: ["GET /orders", "POST /ext"] });
    expect(d.limitations.join()).toContain("example.test");
  });

  it("describes an ECS service and RDS instance and round-trips their ARNs", async () => {
    const { mockClient: mc } = await import("aws-sdk-client-mock");
    const { ECSClient, DescribeServicesCommand } = await import("@aws-sdk/client-ecs");
    const { RDSClient, DescribeDBInstancesCommand } = await import("@aws-sdk/client-rds");
    const tg = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/1";
    const ecs = mc(ECSClient);
    ecs.on(DescribeServicesCommand).resolves({
      services: [
        {
          status: "ACTIVE",
          desiredCount: 2,
          runningCount: 2,
          loadBalancers: [{ targetGroupArn: tg }],
        },
      ],
    });
    mc(RDSClient)
      .on(DescribeDBInstancesCommand)
      .resolves({
        DBInstances: [
          { Engine: "postgres", MultiAZ: true, PubliclyAccessible: false, StorageEncrypted: true },
        ],
      });
    const svcArn = "arn:aws:ecs:us-east-1:123456789012:service/prod/web";
    expect(arnFor("AWS::ECS::Service", svcArn, ctx)).toBe(svcArn);
    expect(physicalIdFromArn(svcArn, ctx)).toBe(svcArn);
    const s = await port.describeResource({
      arn: svcArn,
      physicalId: svcArn,
      type: "AWS::ECS::Service",
    });
    expect(ecs.commandCalls(DescribeServicesCommand)[0]?.args[0].input).toMatchObject({
      cluster: "prod",
    });
    expect(s.summary).toMatchObject({ cluster: "prod", desiredCount: 2 });
    expect(s.links[0]?.to).toBe(tg);
    const dbArn = arnFor("AWS::RDS::DBInstance", "orders-db", ctx)!;
    expect(dbArn).toBe("arn:aws:rds:us-east-1:123456789012:db:orders-db");
    expect(physicalIdFromArn(dbArn, ctx)).toBe("orders-db");
    const db = await port.describeResource({
      arn: dbArn,
      physicalId: "orders-db",
      type: "AWS::RDS::DBInstance",
    });
    expect(db.summary).toMatchObject({
      engine: "postgres",
      multiAz: true,
      publiclyAccessible: false,
    });
  });
});
