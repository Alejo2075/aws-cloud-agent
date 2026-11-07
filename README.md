<p align="center">
  <img src="docs/assets/cloud-agent-banner.gif" alt="Cloud Agent" width="100%">
</p>

Cloud Agent is an open-source, TypeScript agent that understands **existing** AWS applications and helps you change them safely. It discovers what is deployed, builds a source-attributed system graph, answers questions with cited observations, and can propose, validate and, only after explicit approval, apply changes. Reads and writes are separated in code, roles and CLI. It is not a greenfield app generator and not an unrestricted AWS admin tool.

> **Status: v0.4.0 prerelease.** Everything is implemented and tested against fixtures, mocked AWS SDK clients and local CDK synthesis. **It has not been run against a real AWS account or real Bedrock yet.** See [Known limitations](#known-limitations).

<table>
  <tr>
    <td width="120" align="center">
      <a href="https://aws-agent-hackathon.devpost.com/"><img src="docs/assets/aws-ai-agent-hackathon.png" alt="AWS AI Agent Global Hackathon" width="100"></a>
    </td>
    <td>
      This project is part of the <a href="https://aws-agent-hackathon.devpost.com/"><b>AWS AI Agent Global Hackathon</b></a>.
    </td>
  </tr>
</table>

## Capabilities

| Area           | What it does today                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observe        | Scoped, read-only discovery of CloudFormation stacks, tagged resources and explicit ARNs: Lambda, API Gateway (HTTP and REST), DynamoDB, SQS, SNS, S3, EventBridge, Step Functions, Kinesis, ECS services and RDS instances. Relationships carry provenance (`discovery` vs `inferred`). |
| Ask            | Bedrock-backed Q&A using read-only tools. Citations are validated against real tool output; unverifiable citations are removed and the answer says so.                                                                                                                                   |
| Operate (read) | Bounded CloudWatch metrics, Lambda log search, deployment history (CloudFormation, CloudTrail), cost by tag, repository and IaC inspection. Log text and cost data need explicit per-connection consent.                                                                                 |
| Plan           | Model-proposed change plans with a derived risk class and an immutable hash. Nothing is applied.                                                                                                                                                                                         |
| Change         | State machine; approvals bound to plan hash, source revision, environment, account, region, actor and expiry; drift and stale-plan invalidation; idempotent apply through a CloudFormation change-set deployer; hash-chained audit log.                                                  |
| Source changes | Plans can carry patches. After approval, `changes apply` creates a new `cloud-agent/<change-id>` branch in an isolated git worktree (your working tree is untouched), re-verifies the staged files, and only pushes or opens a PR when you pass `--push` / `--pr-base`.                  |
| Verify         | Criteria can be checked automatically: `metric` criteria against recent CloudWatch data, and `http` criteria against hosts you allow (HTTPS GET only, public addresses only). Both fail closed; anything else is confirmed manually.                                                     |
| Validate       | A local worker for convenience, or an ephemeral CodeBuild project (`changes validate --codebuild`) for isolated builds. Terraform checks run only in isolated workers ([guide](docs/terraform.md)).                                                                                      |
| HTTP API       | `apps/api`: framework-agnostic handlers plus an API Gateway HTTP API adapter. Authenticated, per-system authorized, rate-limited; graph, ask, change review and approval. It cannot plan or apply.                                                                                       |
| Hosted state   | `@cloud-agent/stores-aws` (DynamoDB change store and audit log, S3 graph and evidence) and a CDK stack in `infra/`. See [hosted deployment](docs/hosted-deployment.md).                                                                                                                  |
| Plugins        | Hash-pinned read-only tool plugins, in-process or in a permission-restricted process with `--isolated` (Node 25+).                                                                                                                                                                       |
| Import         | `CloudSystemManifest` v1 ([JSON Schema](docs/integration/cloud-system-manifest.schema.json)) as a hint, reconciled against live discovery.                                                                                                                                               |

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

Packages under `packages/` (plus `apps/cli`, `apps/api` and `infra/`): `contracts` (Zod schemas), `connections` (scope), `tools-aws` (read-only ports and SDK adapters), `discovery`, `graph`, `evidence` (redaction, store, audit), `manifest`, `tools-git`, `agent` (tools, ask, planner), `changes` (plans, policy, state machine), `validation`, `deployments`, `stores-aws`; CLI in `apps/cli`. Details: [architecture](docs/architecture.md), [security model](docs/security-model.md), [change lifecycle](docs/change-lifecycle.md).

## Testing

`pnpm test` runs unit and integration tests with in-memory fakes, `aws-sdk-client-mock`, temp git repositories and scripted models. No test contacts AWS.

## Known limitations

- **Not verified live.** No run against a real account, Bedrock, CodeBuild or CloudFormation. Expect integration bugs.
- Resource coverage: see the Observe row above. REST APIs have no metrics yet (CloudWatch keys them by API name, which the graph does not carry). X-Ray, ECS clusters, RDS clusters and other types are listed without configuration or edges, and the graph reports this as a gap.
- Drift detection covers topology and the stable configuration summary of supported resources. The health gate checks CloudFormation stack status and firing CloudWatch alarms that reference in-scope resources; if alarm status cannot be verified the apply is blocked unless you pass `--ignore-alarms`, which is audited. There are no SLO objects.
- The local validation worker is a convenience, not a sandbox; use CodeBuild for isolation.
- A plan deploys either a CloudFormation template you supply (bound to the approved plan by sha256) or its patches on a new branch. Hand-edited or already-modified branches are never touched. There is no Terraform `apply`.
- `apps/api` and the stores and CDK stack are code only: no API Lambda wiring, identity provider integration or retention jobs, and nothing has been deployed. See [hosted deployment](docs/hosted-deployment.md) and the [ROADMAP](ROADMAP.md).
- Isolated plugins need Node 25+ and fail closed on older versions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). The product specification and engineering rules are in [CLAUDE.md](CLAUDE.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
