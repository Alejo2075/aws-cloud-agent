import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CloudAgentStack } from "./stack.js";

// Local synthesis only: nothing here calls AWS, and the placeholder principal is not a real account.
const synth = (extra: object = {}) =>
  Template.fromStack(
    new CloudAgentStack(new App(), "CloudAgent", {
      readerPrincipalArn: "arn:aws:iam::111111111111:role/cloud-agent-runtime",
      ...extra,
    }),
  );

describe("CloudAgentStack", () => {
  it("creates protected, encrypted tables with the keys the stores expect", () => {
    const t = synth();
    t.resourceCountIs("AWS::DynamoDB::Table", 2);
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "changeId", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: "byIdempotencyKey" })],
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "chain", KeyType: "HASH" },
        { AttributeName: "seq", KeyType: "RANGE" },
      ],
    });
    for (const r of Object.values(t.findResources("AWS::DynamoDB::Table")))
      expect(r.DeletionPolicy).toBe("Retain");
  });

  it("makes the state bucket private, TLS-only, versioned and retained", () => {
    const t = synth();
    t.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
      VersioningConfiguration: { Status: "Enabled" },
    });
    t.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      }),
    });
  });

  it("grants the read-only role only list/describe/get actions", () => {
    const t = synth({ externalId: "ext-123" });
    const doc = JSON.stringify(t.findResources("AWS::IAM::Policy"));
    const actions: string[] = Object.values(t.findResources("AWS::IAM::Policy")).flatMap((p) =>
      (p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>).flatMap((s) =>
        [s.Action].flat(),
      ),
    );
    expect(actions.length).toBeGreaterThan(10);
    for (const a of actions)
      expect(a, a).toMatch(/:(Get|Describe|List|BatchGet)|^tag:GetResources$|^apigateway:GET$/);
    expect(actions.some((a) => a.includes("*"))).toBe(false);
    expect(doc).toContain("/restapis/*");
    t.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Condition: { StringEquals: { "sts:ExternalId": "ext-123" } } }),
        ]),
      }),
    });
  });
});
