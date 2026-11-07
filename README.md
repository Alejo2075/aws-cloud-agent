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

Cloud Agent is an open-source TypeScript agent for **existing** AWS applications. It discovers what is deployed, answers questions with cited evidence, and can propose, validate and, only after explicit approval, apply changes. Reads and writes are kept separate in code, roles and CLI.

<p align="center">
  <a href="https://aws-agent-hackathon.devpost.com/"><img src="docs/assets/aws-ai-agent-hackathon.png" alt="" height="28" align="absmiddle"></a>
  This project is part of the <a href="https://aws-agent-hackathon.devpost.com/"><b>AWS AI Agent Global Hackathon</b></a>
</p>

## Features

- **Observe**: scoped, read-only discovery into a system graph (Lambda, API Gateway, DynamoDB, SQS, SNS, S3, EventBridge, Step Functions, Kinesis, ECS, RDS).
- **Ask**: Bedrock Q&A over read-only tools; unverifiable citations are removed.
- **Operate**: bounded metrics, logs, deployment history, cost and repository inspection (logs and cost need explicit consent).
- **Change**: plans bound to an immutable hash, approvals tied to the exact plan and target, applied through CloudFormation change sets or a new git branch, then verified and audited.
- **Extend**: hash-pinned read-only plugins (optionally isolated), `CloudSystemManifest` import, DynamoDB/S3 stores and a CDK stack.

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

Run from source with `pnpm --filter @cloud-agent/cli start -- --help`. State lives in `~/.cloud-agent`; credentials are never stored.

## Limitations

- **Not verified live** against real AWS, Bedrock, CodeBuild or CloudFormation. Expect integration bugs.
- The HTTP API, DynamoDB/S3 stores and CDK stack are code only and have not been deployed.
- No Terraform apply, no SLO objects, and some resource types are listed without configuration.

More in the [ROADMAP](ROADMAP.md). Docs: [architecture](docs/architecture.md), [change lifecycle](docs/change-lifecycle.md), [hosted deployment](docs/hosted-deployment.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under [Apache-2.0](LICENSE).
