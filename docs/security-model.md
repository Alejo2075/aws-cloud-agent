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

## Source-change branches

`GitBranchDeployer` applies approved patches only to a new branch in a temporary git worktree, from the exact revision the plan was made against, and never to an existing branch or with force. Patch headers are parsed fail-closed (unknown, quoted or odd headers reject the patch); paths, secret-bearing files and file modes (symlinks, submodules, special modes) are checked both in the patch and again on what git actually staged, before committing. A failed run deletes the branch it created.

## Plugins

Plugins are code that runs in the Cloud Agent process with your privileges. The registry only limits what the _agent_ can call (read-only tools), not what plugin code can do. Entries must be absolute paths pinned by sha256 in `plugins.json`; a changed file is not loaded. Only pin plugins you have reviewed, shipped as a single bundled file (the hash covers the entry file only).

### Isolated plugins

`cloud-agent plugins add --isolated <file>` pins a plugin to run in a separate Node process under the permission model: no network, no child processes, no workers, no native addons, no file writes, reads limited to the pinned file, and an empty environment. The plugin receives only the validated tool input and returns plain data (capped at 64 KB, 10 s per call); it gets no graph, evidence or credentials. The host checks the child's reported capabilities and refuses to register the tools if any restriction is not in force. It needs Node 25+ (older versions cannot deny network access) and fails closed otherwise. Isolation is process-level, not a VM: it relies on Node's permission model and is not a defense against a Node vulnerability. Isolated plugins export `tools` (name, description, JSON Schema `inputSchema`, `run(input)`) as a single bundled file.

## HTTP API

Every route authenticates, authorizes per system and environment (deny by default), rate-limits per principal, bounds the body size, audits, and returns opaque 500s. Approval actors always come from the authenticated principal. A caller with no grant on a system gets the same 404 as for a missing system. Plan and apply are intentionally not exposed. Authentication (e.g. JWT verification) is injected by you; this repo ships none.

## Terraform

Cloud Agent never runs `terraform plan` or `apply`. `terraform init` downloads providers and runs their binaries, so the helper checks are for network-controlled isolated workers only and the local validator refuses them.

## Not covered yet

The local validation runner is not a sandbox. Network egress controls, KMS-encrypted storage, multi-tenant hosting and a hosted API are out of scope for v0.1.0.

## Outbound verification calls

`http` verification criteria are the only place Cloud Agent makes an outbound request on a plan's behalf. They are off unless the connection lists hosts (`connect --verify-host`). Requests are HTTPS GET only, to an exact allowed hostname on the default port, with no credentials, IP literals or redirects. The resolver answer is checked at connect time and any loopback, private, link-local (including the metadata address), CGNAT, multicast or reserved address is refused, so DNS rebinding cannot reach internal services. The response body is discarded.
