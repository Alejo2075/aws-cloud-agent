# Progress

Source of truth for scope and order: `CLAUDE.md`. Constraint from the owner: **no live AWS calls and no deployments** to their account; everything is verified with fixtures, `aws-sdk-client-mock` and local synth only.

Branch: `feat/foundation` (pushed). Last verified: typecheck, lint, format and 75 tests passing locally.

## Done

- **M0**: pnpm workspace, strict TS (6.0.x), ESLint, Prettier, Vitest, CI workflow, contracts (scope, connection, evidence, graph, source), deny-by-default scope evaluation.
- **M1**: read-only discovery (CloudFormation, tags, ARNs; Lambda, API Gateway v2, DynamoDB, SQS, SNS, S3, EventBridge), System Graph with provenance and inferred edges, evidence store with redaction, hash-chained audit log, manifest import and reconciliation (+ published JSON Schema), Bedrock-backed `ask` with citation validation and budgets, CLI (`connect`, `systems list|inspect|refresh`, `ask`, `audit`).
- **M2**: bounded metrics, logs (content gated by `sensitiveDataAccess`), deployment history, cost by tag (gated by `costDataAccess`), repository inspection, IaC detection, source mapping; all exposed as read-only agent tools.

## Remaining (in order)

- **M3** (not started): `packages/changes` (state machine, plan hash, approval binding, policy/risk gates, idempotency, stale-plan invalidation), `validation` (isolated worker interface), `deployments` (gated adapters, CloudFormation change set; tests with mocks only), CLI `plan` / `changes *`, audit for every transition.
- **M4**: Terraform detection/plan adapter, plugin/tool registry API, lifecycle events, `apps/api`, CDK `infra/` (local `cdk synth` only, never deploy).
- **Release engineering**: LICENSE (Apache-2.0 proposed), README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, docs (architecture, security model, IAM read-only policy), issue/PR templates, dependabot, fix GitHub description/topics (current description is copied from Cloud Engineer), PR to `main`, prerelease `v0.1.0` tag.

## Not verified

Nothing has run against a real AWS account or real Bedrock. SDK integrations are covered by mocked-client tests only.
