import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table, TableEncryption } from "aws-cdk-lib/aws-dynamodb";
import { ArnPrincipal, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface CloudAgentStackProps extends StackProps {
  /** Principal allowed to assume the read-only role (for example the role Cloud Agent runs as). */
  readerPrincipalArn: string;
  /** Optional ExternalId required on AssumeRole (confused-deputy protection). */
  externalId?: string;
}

/**
 * Cloud Agent's own state: change records, the hash-chained audit log, and graph/evidence objects.
 * Everything is encrypted, non-public and retained on stack deletion; audit data is never auto-deleted.
 */
export class CloudAgentStack extends Stack {
  readonly changes: Table;
  readonly audit: Table;
  readonly bucket: Bucket;
  readonly readOnlyRole: Role;

  constructor(scope: Construct, id: string, props: CloudAgentStackProps) {
    super(scope, id, props);

    const table = (name: string, pk: string, sk?: { name: string; type: AttributeType }) =>
      new Table(this, name, {
        partitionKey: { name: pk, type: AttributeType.STRING },
        ...(sk && { sortKey: sk }),
        billingMode: BillingMode.PAY_PER_REQUEST,
        encryption: TableEncryption.AWS_MANAGED,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    this.changes = table("Changes", "changeId");
    this.changes.addGlobalSecondaryIndex({
      indexName: "byIdempotencyKey",
      partitionKey: { name: "idempotencyKey", type: AttributeType.STRING },
    });
    this.audit = table("Audit", "chain", { name: "seq", type: AttributeType.NUMBER });

    this.bucket = new Bucket(this, "State", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }],
    });

    // The read-only role is the boundary the Observe/Ask modes run under: list/describe/get only.
    this.readOnlyRole = new Role(this, "ReadOnlyRole", {
      assumedBy: new ArnPrincipal(props.readerPrincipalArn),
      description: "Cloud Agent read-only discovery and telemetry access",
      maxSessionDuration: Duration.hours(1),
      ...(props.externalId && { externalIds: [props.externalId] }),
    });
    this.readOnlyRole.addToPolicy(
      new PolicyStatement({
        sid: "DiscoveryReadOnly",
        actions: [
          "cloudformation:ListStackResources",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "tag:GetResources",
          "lambda:GetFunctionConfiguration",
          "lambda:ListEventSourceMappings",
          "dynamodb:DescribeTable",
          "dynamodb:DescribeContinuousBackups",
          "sqs:GetQueueAttributes",
          "s3:GetBucketNotification",
          "sns:GetTopicAttributes",
          "sns:ListSubscriptionsByTopic",
          "events:DescribeRule",
          "events:ListTargetsByRule",
          "states:DescribeStateMachine",
          "kinesis:DescribeStreamSummary",
          "ecs:DescribeServices",
          "rds:DescribeDBInstances",
          "cloudwatch:GetMetricData",
          "cloudwatch:DescribeAlarms",
        ],
        resources: ["*"],
      }),
    );
    // API Gateway reads are limited to API definitions, so API keys and usage plans stay unreadable.
    this.readOnlyRole.addToPolicy(
      new PolicyStatement({
        sid: "ApiDefinitionsOnly",
        actions: ["apigateway:GET"],
        resources: [
          `arn:${this.partition}:apigateway:*::/apis/*`,
          `arn:${this.partition}:apigateway:*::/restapis/*`,
        ],
      }),
    );
    // Log content, Cost Explorer and CloudTrail are consent-gated in the product and are deliberately not granted here.

    new CfnOutput(this, "ChangesTable", { value: this.changes.tableName });
    new CfnOutput(this, "AuditTable", { value: this.audit.tableName });
    new CfnOutput(this, "StateBucket", { value: this.bucket.bucketName });
    new CfnOutput(this, "ReadOnlyRoleArn", { value: this.readOnlyRole.roleArn });
  }
}
