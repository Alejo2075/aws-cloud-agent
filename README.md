<p align="center">
  <img src="docs/assets/cloud-agent-banner.gif" alt="Cloud Agent" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Alejo2075/aws-cloud-agent/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Alejo2075/aws-cloud-agent/ci.yml?branch=main&label=CI&labelColor=1a1033&style=flat"></a>
  <a href="https://github.com/Alejo2075/aws-cloud-agent/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Alejo2075/aws-cloud-agent?include_prereleases&color=8B2CF5&labelColor=1a1033&style=flat"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-C42DE0?labelColor=1a1033&style=flat"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-E835C8?labelColor=1a1033&style=flat&logo=typescript&logoColor=white">
  <img alt="Amazon Bedrock" src="https://img.shields.io/badge/Amazon-Bedrock-F062B0?labelColor=1a1033&style=flat&logo=amazonaws&logoColor=white">
</p>

Cloud Agent is a serverless AI agent to understand, troubleshoot, manage, and evolve existing AWS applications through natural language. It discovers what is deployed, answers with cited evidence, and applies changes only after explicit approval. Reads and writes are kept separate in code, roles and CLI.

<p align="center">
  <a href="https://aws-agent-hackathon.devpost.com/"><img src="docs/assets/aws-ai-agent-hackathon.png" alt="" height="28" align="absmiddle"></a>
  This project is part of the <a href="https://aws-agent-hackathon.devpost.com/"><b>AWS AI Agent Global Hackathon</b></a>
</p>

## Features

- **Understand**: scoped, read-only discovery into a system graph (Lambda, API Gateway, DynamoDB, SQS, SNS, S3, EventBridge, Step Functions, Kinesis, ECS, RDS), and Bedrock Q&A over it. Every relationship says whether it was discovered or inferred, and unverifiable citations are removed.
- **Troubleshoot**: bounded metrics, logs, deployment history, cost and repository inspection to find what changed and where (logs and cost need explicit consent).
- **Manage and evolve**: plans bound to an immutable hash, approvals tied to the exact plan and target, applied through CloudFormation change sets or a new git branch, then verified and audited.
- **Extend**: hash-pinned read-only plugins (optionally isolated), `CloudSystemManifest` import, DynamoDB/S3 stores and a CDK stack.

## How it works

1. **Connect**: you declare a scope (stacks, tags or ARNs) and a read-only role. Nothing outside it is touched.
2. **Discover**: the agent describes in-scope resources and builds a graph with provenance, freshness and known gaps.
3. **Ask**: questions are answered with read-only tools; every claim cites a recorded observation.
4. **Plan**: a change request becomes a plan with a risk class and a hash. It is a proposal; nothing is applied.
5. **Approve**: a person approves the exact plan for one account, region and environment. Drift or a moved revision invalidates the approval.
6. **Apply and verify**: a deployer with a separate write role applies it, criteria are checked, and every step lands in a hash-chained audit log.

## Quick start

Requires Node.js 22+, pnpm 9, a read-only IAM role you create ([security model](docs/security-model.md)) and a Bedrock model.

```bash
git clone https://github.com/Alejo2075/aws-cloud-agent.git
cd aws-cloud-agent && pnpm install && pnpm check
```

```bash
cloud-agent connect --stack restaurant-app-prod --region us-east-1 \
  --role-arn arn:aws:iam::123456789012:role/CloudAgentReadOnly --system restaurant-app
export CLOUD_AGENT_MODEL_ID=<your Bedrock model or inference profile id>
cloud-agent ask --system restaurant-app "How does a reservation flow through this application?"
cloud-agent plan --system restaurant-app "Set the checkout timeout to 20 seconds"
cloud-agent changes approve <change-id> --system restaurant-app
```

Run from source with `pnpm --filter @cloud-agent/cli start -- --help`.

## Architecture

```text
CLI / API ─► policy + scope ─► agent (read-only tools) ─► system graph + evidence ─► answer
                  └─► change service ─► plan ─► validate ─► approval ─► deployer ─► verify
                                every step ─► hash-chained audit log
```

- **Read and write are separate.** The AWS read ports only list, describe and get; the only writers are deployers, and they need an authorization that only the policy check can mint.
- **Everything external is untrusted.** Logs, repository files and tool output are wrapped and redacted before they reach a model.
- **Storage sits behind interfaces**, with file-based stores by default and DynamoDB/S3 implementations available.

| Path                                                          | Purpose                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/cli`, `apps/api`                                        | Command line and HTTP handlers                          |
| `packages/agent`, `packages/tools-*`                          | Orchestration, plugins and read-only AWS and git tools  |
| `packages/discovery`, `graph`, `evidence`                     | Discovery, system graph, redaction and audit log        |
| `packages/changes`, `validation`, `deployments`               | Plans, state machine, validators and deployers          |
| `packages/contracts`, `connections`, `manifest`, `stores-aws` | Schemas, scoping, manifest import and AWS-backed stores |
| `infra`                                                       | CDK stack for Cloud Agent's own state                   |

## Configuration

| Setting                           | Purpose                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CLOUD_AGENT_HOME`                | State directory (default `~/.cloud-agent`): profiles, graphs, evidence, changes, audit log. Credentials are never stored. |
| `CLOUD_AGENT_MODEL_ID`            | Bedrock model or inference profile id (or `--model`).                                                                     |
| `connect --stack / --tag / --arn` | Scope selectors; repeat them to add more.                                                                                 |
| `connect --role-arn`              | Read-only role, assumed per run. `--planning-role-arn` and `--write-role-arn` are separate.                               |
| `connect --repo`                  | Local checkout to inspect and, after approval, branch from.                                                               |
| `connect --event-bus`             | EventBridge bus that receives change lifecycle events (identifiers and states only).                                      |
| `connect --verify-host`           | Hostnames that `http` verification criteria may call. None by default.                                                    |
| `connect --manifest`              | `CloudSystemManifest` used as a hint and checked against live discovery.                                                  |
| `plugins add [--isolated]`        | Pin a read-only plugin by sha256; `--isolated` runs it in a restricted process (Node 25+).                                |

Consent for log contents and cost data is off by default and set per connection profile.

## Documentation

- [Architecture](docs/architecture.md) and [security model](docs/security-model.md)
- [Change lifecycle](docs/change-lifecycle.md)
- [Terraform through an isolated worker](docs/terraform.md)
- [Hosted deployment](docs/hosted-deployment.md)
- [CloudSystemManifest schema](docs/integration/cloud-system-manifest.schema.json) and [CHANGELOG](CHANGELOG.md)

## Project status & roadmap

**v0.4.1 prerelease.** The test suite uses fixtures and mocked AWS clients; validation in a live AWS account is the next milestone.

Also planned: hosted deployment wiring, Terraform apply, SLO objects and more resource coverage. See the [ROADMAP](ROADMAP.md).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; the product specification and engineering rules are in [CLAUDE.md](CLAUDE.md). `pnpm check` must pass.

## Security & license

Report vulnerabilities privately through GitHub (Security, then Report a vulnerability); see [SECURITY.md](SECURITY.md). Licensed under [Apache-2.0](LICENSE).
