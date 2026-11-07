import { APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { ApiGatewayV2Client } from "@aws-sdk/client-apigatewayv2";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECSClient } from "@aws-sdk/client-ecs";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { KinesisClient } from "@aws-sdk/client-kinesis";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SFNClient } from "@aws-sdk/client-sfn";
import { RDSClient } from "@aws-sdk/client-rds";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { STSClient } from "@aws-sdk/client-sts";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";

export interface AwsClients {
  cfn: CloudFormationClient;
  lambda: LambdaClient;
  dynamodb: DynamoDBClient;
  sqs: SQSClient;
  s3: S3Client;
  sns: SNSClient;
  events: EventBridgeClient;
  apigw: ApiGatewayV2Client;
  tagging: ResourceGroupsTaggingAPIClient;
  sfn: SFNClient;
  kinesis: KinesisClient;
  restApi: APIGatewayClient;
  ecs: ECSClient;
  rds: RDSClient;
}

export function createClients(
  region: string,
  credentials?: AwsCredentialIdentityProvider,
): AwsClients {
  const cfg = { region, ...(credentials && { credentials }), maxAttempts: 4 };
  return {
    cfn: new CloudFormationClient(cfg),
    lambda: new LambdaClient(cfg),
    dynamodb: new DynamoDBClient(cfg),
    sqs: new SQSClient(cfg),
    s3: new S3Client(cfg),
    sns: new SNSClient(cfg),
    events: new EventBridgeClient(cfg),
    apigw: new ApiGatewayV2Client(cfg),
    tagging: new ResourceGroupsTaggingAPIClient(cfg),
    sfn: new SFNClient(cfg),
    kinesis: new KinesisClient(cfg),
    restApi: new APIGatewayClient(cfg),
    ecs: new ECSClient(cfg),
    rds: new RDSClient(cfg),
  };
}

/** Short-lived, role-based credentials. Cloud Agent never uses persistent access keys. */
export function assumeRole(
  roleArn: string,
  region: string,
  sessionName = "cloud-agent",
  externalId?: string,
) {
  return fromTemporaryCredentials({
    params: {
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: 900,
      ...(externalId && { ExternalId: externalId }),
    },
    clientConfig: { region },
  });
}

export async function callerIdentity(region: string, credentials?: AwsCredentialIdentityProvider) {
  const sts = new STSClient({ region, ...(credentials && { credentials }) });
  const { GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const r = await sts.send(new GetCallerIdentityCommand({}));
  return { accountId: r.Account ?? "", arn: r.Arn ?? "" };
}
