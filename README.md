# Cloud Agent

Evidence-backed understanding of **existing** AWS applications, with approval-gated changes. Cloud Agent discovers what is deployed, builds a source-attributed system graph, answers questions with cited observations, and can propose, validate and (after explicit approval) apply changes to an application you already run.

> **Status: v0.2.0 prerelease.** Everything is implemented and tested against fixtures and mocked AWS SDK clients. **It has not been run against a real AWS account or real Bedrock yet.** See [Known limitations](#known-limitations).

It is not a greenfield app generator and not an unrestricted AWS admin tool. Reads and writes are separated in code, roles and CLI.

## Capabilities

| Area           | What it does today                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observe        | Scoped, read-only discovery of CloudFormation stacks, tagged resources and explicit ARNs: Lambda, API Gateway (HTTP), DynamoDB, SQS, SNS, S3, EventBridge. Relationships carry provenance (`discovery` vs `inferred`).                            |
| Ask            | Bedrock-backed Q&A using read-only tools. Citations are validated against real tool output; unverifiable citations are removed and the answer says so.                                                                                            |
| Operate (read) | Bounded CloudWatch metrics, Lambda log search, deployment history (CloudFormation, CloudTrail), cost by tag, repository and IaC inspection. Log text and cost data need explicit per-connection consent.                                          |
| Plan           | Model-proposed change plans with a derived risk class and an immutable hash. Nothing is applied.                                                                                                                                                  |
| Change         | State machine, approvals bound to plan hash, source revision, environment, account, region, actor and expiry; drift/stale-plan invalidation; idempotent apply through a CloudFormation change-set deployer; verification; hash-chained audit log. |
| Import         | `CloudSystemManifest` v1 ([JSON Schema](docs/integration/cloud-system-manifest.schema.json)) as a hint, reconciled against live discovery.                                                                                                        |

## Requirements

- Node.js 22+ and pnpm 9
- For real use: an IAM **read-only role** you create (see [security model](docs/security-model.md)), and a Bedrock model or inference profile enabled in your account.

## Install and develop

```bash
git clone https://github.com/Alejo2075/aws-cloud-agent.git
cd aws-cloud-agent
pnpm install
pnpm check        # typecheck, lint, format, tests
```

Run the CLI from source:

```bash
pnpm --filter @cloud-agent/cli start -- --help
```

## Quick start

```bash
# 1. Register a scoped read-only connection and run discovery
cloud-agent connect --stack restaurant-app-prod --region us-east-1 \
  --role-arn arn:aws:iam::123456789012:role/CloudAgentReadOnly \
  --system restaurant-app --repo ../restaurant-app

# 2. Inspect and ask
cloud-agent systems inspect restaurant-app
export CLOUD_AGENT_MODEL_ID=<your Bedrock model or inference profile id>
cloud-agent ask --system restaurant-app "How does a reservation flow through this application?"

# 3. Propose a change (read-only), then review it
cloud-agent plan --system restaurant-app --template cdk.out/app.template.json --stack app "Set the checkout timeout to 20 seconds"
cloud-agent changes show <change-id> --system restaurant-app
cloud-agent changes validate <change-id> --system restaurant-app --check "pnpm test"
cloud-agent changes approve <change-id> --system restaurant-app
cloud-agent changes apply <change-id> --system restaurant-app --template cdk.out/app.template.json
cloud-agent changes verify <change-id> --system restaurant-app --confirm v1
cloud-agent audit
```

State lives in `~/.cloud-agent` (override with `CLOUD_AGENT_HOME`). Credentials are never stored; roles are assumed per run.

## Architecture

Packages under `packages/`: `contracts` (Zod schemas), `connections` (scope), `tools-aws` (read-only ports and SDK adapters), `discovery`, `graph`, `evidence` (redaction, store, audit), `manifest`, `tools-git`, `agent` (tools, ask, planner), `changes` (plans, policy, state machine), `validation`, `deployments`; CLI in `apps/cli`. Details: [architecture](docs/architecture.md), [security model](docs/security-model.md), [change lifecycle](docs/change-lifecycle.md).

## Testing

`pnpm test` runs unit and integration tests with in-memory fakes, `aws-sdk-client-mock`, temp git repositories and scripted models. No test contacts AWS.

## Known limitations

- **Not verified live.** No run against a real account, Bedrock, CodeBuild or CloudFormation. Expect integration bugs.
- Resource coverage is limited to the services above; REST APIs (v1), Step Functions, ECS, RDS and others are listed without configuration or edges, and the graph reports this as a gap.
- Drift detection covers topology and the stable configuration summary of supported resources; resources without a describer are not covered. The health gate checks CloudFormation stack status only (no alarm or SLO checks).
- The local validation worker is a convenience, not a sandbox. `CodeBuildValidator` exists for isolated builds but is only tested with mocks and is not yet selectable from the CLI.
- The planner proposes plans and edits as data; automatic application of code patches to a branch/PR is not implemented. Deployment is by CloudFormation change set from a template you supply, bound to the approved plan by sha256.
- Terraform is detected but has no plan/apply adapter. No hosted API (`apps/api`), CDK stack for Cloud Agent itself, plugin discovery/loading (a `ToolRegistry` API exists) or CLI wiring for lifecycle events yet. See [ROADMAP](ROADMAP.md).
- Verification of metric/HTTP criteria is manual (`--confirm`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). The product specification and engineering rules are in [CLAUDE.md](CLAUDE.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
