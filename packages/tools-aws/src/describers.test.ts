import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GetApiCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
} from "@aws-sdk/client-apigatewayv2";
import { ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
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
