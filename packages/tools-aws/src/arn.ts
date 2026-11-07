import type { AwsContext } from "./port.js";

/** Build an ARN from a CloudFormation physical id. Returns undefined for types without a derivable ARN. */
export function arnFor(type: string, physicalId: string, ctx: AwsContext): string | undefined {
  const { region, accountId: a } = ctx;
  switch (type) {
    case "AWS::Lambda::Function":
      return `arn:aws:lambda:${region}:${a}:function:${physicalId}`;
    case "AWS::DynamoDB::Table":
      return `arn:aws:dynamodb:${region}:${a}:table/${physicalId}`;
    case "AWS::SQS::Queue": {
      const name = physicalId.split("/").pop();
      return name ? `arn:aws:sqs:${region}:${a}:${name}` : undefined;
    }
    case "AWS::S3::Bucket":
      return `arn:aws:s3:::${physicalId}`;
    case "AWS::SNS::Topic":
      return physicalId.startsWith("arn:") ? physicalId : undefined;
    case "AWS::Events::EventBus":
      return `arn:aws:events:${region}:${a}:event-bus/${physicalId}`;
    case "AWS::Events::Rule": {
      const [bus, name] = physicalId.includes("|")
        ? physicalId.split("|")
        : [undefined, physicalId];
      return `arn:aws:events:${region}:${a}:rule/${bus ? `${bus}/` : ""}${name}`;
    }
    case "AWS::ApiGatewayV2::Api":
      return `arn:aws:apigateway:${region}::/apis/${physicalId}`;
    case "AWS::ApiGateway::RestApi":
      return `arn:aws:apigateway:${region}::/restapis/${physicalId}`;
    case "AWS::StepFunctions::StateMachine":
      return physicalId.startsWith("arn:") ? physicalId : undefined;
    case "AWS::Kinesis::Stream":
      return `arn:aws:kinesis:${region}:${a}:stream/${physicalId}`;
    case "AWS::ECS::Cluster":
      return physicalId.startsWith("arn:")
        ? physicalId
        : `arn:aws:ecs:${region}:${a}:cluster/${physicalId}`;
    case "AWS::ECS::Service":
      return physicalId.startsWith("arn:") ? physicalId : undefined;
    case "AWS::RDS::DBInstance":
      return `arn:aws:rds:${region}:${a}:db:${physicalId}`;
    default:
      return undefined;
  }
}

const TYPE_BY_ARN: Array<[RegExp, string]> = [
  [/^arn:aws:lambda:[^:]*:[^:]*:function:/, "AWS::Lambda::Function"],
  [/^arn:aws:dynamodb:[^:]*:[^:]*:table\/[^/]+$/, "AWS::DynamoDB::Table"],
  [/^arn:aws:sqs:/, "AWS::SQS::Queue"],
  [/^arn:aws:s3:::[^/]+$/, "AWS::S3::Bucket"],
  [/^arn:aws:sns:/, "AWS::SNS::Topic"],
  [/^arn:aws:events:[^:]*:[^:]*:event-bus\//, "AWS::Events::EventBus"],
  [/^arn:aws:events:[^:]*:[^:]*:rule\//, "AWS::Events::Rule"],
  [/^arn:aws:apigateway:[^:]*::\/apis\//, "AWS::ApiGatewayV2::Api"],
  [/^arn:aws:apigateway:[^:]*::\/restapis\//, "AWS::ApiGateway::RestApi"],
  [/^arn:aws:states:[^:]*:[^:]*:stateMachine:/, "AWS::StepFunctions::StateMachine"],
  [/^arn:aws:kinesis:[^:]*:[^:]*:stream\//, "AWS::Kinesis::Stream"],
  [/^arn:aws:ecs:[^:]*:[^:]*:cluster\//, "AWS::ECS::Cluster"],
  [/^arn:aws:ecs:[^:]*:[^:]*:service\//, "AWS::ECS::Service"],
  [/^arn:aws:rds:[^:]*:[^:]*:db:/, "AWS::RDS::DBInstance"],
];

export function typeFromArn(arn: string): string {
  return TYPE_BY_ARN.find(([re]) => re.test(arn))?.[1] ?? `arn:${arn.split(":")[2] ?? "unknown"}`;
}

/** Inverse of arnFor for resources found by ARN/tag: recover the identifier the service APIs expect. */
export function physicalIdFromArn(arn: string, ctx: AwsContext): string {
  const p = arn.split(":");
  switch (typeFromArn(arn)) {
    case "AWS::Lambda::Function":
      return p[6] ?? arn;
    case "AWS::DynamoDB::Table":
      return (p[5] ?? "").replace(/^table\//, "");
    case "AWS::SQS::Queue":
      return `https://sqs.${ctx.region}.amazonaws.com/${ctx.accountId}/${p[5] ?? ""}`;
    case "AWS::S3::Bucket":
      return arn.replace("arn:aws:s3:::", "");
    case "AWS::Events::EventBus":
      return (p[5] ?? "").replace(/^event-bus\//, "");
    case "AWS::Events::Rule": {
      const rest = (p[5] ?? "").replace(/^rule\//, "");
      return rest.includes("/") ? rest.replace("/", "|") : rest;
    }
    case "AWS::ApiGatewayV2::Api":
    case "AWS::ApiGateway::RestApi":
      return arn.split("/").pop() ?? arn;
    case "AWS::StepFunctions::StateMachine":
      return arn;
    case "AWS::Kinesis::Stream":
      return (p[5] ?? "").replace(/^stream\//, "");
    case "AWS::ECS::Cluster":
      return (p[5] ?? "").replace(/^cluster\//, "");
    case "AWS::ECS::Service":
      return arn;
    case "AWS::RDS::DBInstance":
      return p[6] ?? arn;
    default:
      return arn;
  }
}

/** Stream ARNs and queue/topic subscriptions point at the table, not the stream, in the graph. */
export function normalizeTargetArn(arn: string): string {
  const m = /^(arn:aws:dynamodb:[^:]*:[^:]*:table\/[^/]+)\/stream\//.exec(arn);
  return m?.[1] ?? arn;
}
