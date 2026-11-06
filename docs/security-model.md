# Security model

## Roles

Use separate IAM roles, assumed per run through STS (no stored keys): **read-only** (required), **write** (optional, only used after policy authorizes an apply). Cloud Agent never needs account-wide permissions; scope resources in the role policy as tightly as you can. Cloud Agent does not create these roles for you.

### Example read-only policy (adapt `Resource`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Discovery",
      "Effect": "Allow",
      "Resource": "*",
      "Action": [
        "cloudformation:ListStackResources",
        "cloudformation:DescribeStackEvents",
        "tag:GetResources",
        "lambda:GetFunctionConfiguration",
        "lambda:ListEventSourceMappings",
        "apigateway:GET",
        "events:DescribeRule",
        "events:ListTargetsByRule",
        "sns:GetTopicAttributes",
        "sns:ListSubscriptionsByTopic",
        "s3:GetBucketNotification",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeContinuousBackups",
        "sqs:GetQueueAttributes"
      ]
    },
    {
      "Sid": "Telemetry",
      "Effect": "Allow",
      "Resource": "*",
      "Action": ["cloudwatch:GetMetricData", "cloudtrail:LookupEvents"]
    },
    {
      "Sid": "OptionalLogs",
      "Effect": "Allow",
      "Resource": "arn:aws:logs:*:*:log-group:/aws/lambda/*",
      "Action": "logs:FilterLogEvents"
    },
    { "Sid": "OptionalCost", "Effect": "Allow", "Resource": "*", "Action": "ce:GetCostAndUsage" }
  ]
}
```

Prefer a trust policy that restricts who can assume the role, and an `ExternalId` where appropriate.

## Consent switches (per connection, default off)

- `sensitiveDataAccess`: lets Lambda log _messages_ (redacted, size-bounded) reach the model. Without it only match counts are returned.
- `costDataAccess`: allows Cost Explorer queries scoped to the connection's tag selector.
- Repository access exists only if you pass `--repo`; secret-bearing files (`.env`, keys, tfstate) and paths outside the checkout are refused.

## Threats and controls

| Threat                                 | Control                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Prompt injection via logs, names, code | `<untrusted>` wrapping, redaction, read-only tool set, no authorization from model output, unknown tools rejected |
| Out-of-scope access                    | scope evaluation, account/region checks, port surface limited to read operations                                  |
| Unapproved or stale writes             | branded `Authorization`, plan-hash-bound approvals, pre-write drift/source re-check, template sha256 binding      |
| Runaway loops/spend                    | turn, tool-call and repetition limits; discovery resource budget; time-range, point and log-event caps            |
| Secret leakage                         | key- and pattern-based redaction in evidence, logs, repo reads; env var values never stored                       |
| Audit tampering                        | hash-chained JSONL audit (`cloud-agent audit` verifies)                                                           |

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).

## Not covered yet

The local validation runner is not a sandbox. Network egress controls, KMS-encrypted storage, multi-tenant hosting and a hosted API are out of scope for v0.1.0.
