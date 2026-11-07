# Changelog

All notable changes are documented here. Format based on Keep a Changelog; versioning follows SemVer (0.x: minor versions may break).

## [Unreleased]

### Added

- Metric catalog supports several required dimensions per resource; ECS services (`ClusterName` + `ServiceName`) get metrics. Alarm matching now requires every dimension of a resource, so a cluster-only alarm does not flag a service. Old-format ECS ARNs are refused rather than guessed. Mock-tested only.

## [0.3.2] - 2026-11-07 (prerelease)

### Added

- Resource coverage: API Gateway REST APIs (Lambda integrations as edges), ECS services (load balancer target groups) and RDS instances (configuration summary and metrics). Mock-tested only.

## [0.3.1] - 2026-11-06 (prerelease)

### Added

- Automatic verification of `metric` criteria: a plan criterion may carry a structured `check` (resource, metric, stat, comparator, threshold, window of 5-360 minutes). `changes verify` evaluates it read-only against recent telemetry and fails closed on missing data, unknown resources or query errors. Verified with mocks only; not run against real CloudWatch.

## [0.3.0] - 2026-11-06 (prerelease)

### Added

- `GitBranchDeployer`: approved patches go to a new branch in an isolated worktree; optional push and PR; strict fail-closed patch parsing and verification of the staged file set.
- `apps/api`: authenticated, authorized, rate-limited HTTP handlers (graph, ask, changes, approve, audit) and an API Gateway HTTP API adapter. No plan/apply over HTTP.
- Hash-pinned plugin loader and `cloud-agent plugins add|list|remove`.
- Alarm-based health gate (fails closed; composite alarms and truncated listings block; audited `--ignore-alarms`).
- Step Functions and Kinesis resources in the graph and metric catalog.
- CLI wiring: `changes validate --codebuild`, `connect --event-bus`, `--planning-role-arn`.

### Security

- Terraform checks are refused by the local (non-sandboxed) validator and block module downloads.
- API returns identical 404s for missing systems and systems the caller has no grant on.

## [0.2.0] - 2026-11-06 (prerelease)

### Added

- Stack health gate before writes (CloudFormation stack status) and configuration-level drift detection (stable config digests in the graph fingerprint).
- `CodeBuildValidator`: ephemeral validation pinned to the plan's source revision (mocked tests only).
- Lifecycle events: `EventPublisher` port and `EventBridgePublisher`; publishing is best-effort and failures are audited, never blocking a change.
- `ToolRegistry`: extension point for read-only plugin tools; mutating, reserved or duplicate tools are rejected.

### Known limitations

Still not verified against a live AWS account. Not implemented: Terraform adapter, branch/PR adapter, hosted API, CDK stack for Cloud Agent itself. See ROADMAP.

## [0.1.0] - 2026-11-06 (prerelease)

### Added

- Read-only discovery, System Graph with provenance, evidence store, redaction, hash-chained audit log.
- Bedrock-backed `ask` with citation validation; metrics, logs, deployment history, cost, repository and IaC tools.
- `CloudSystemManifest` v1 import, JSON Schema and reconciliation.
- Change planning, plan-hash-bound approvals, policy gates, state machine, local validation runner, CloudFormation change-set deployer, `plan` / `changes` commands.
- Apache-2.0 license, security model, CI with pinned actions, CodeQL, dependency audit, tag-driven release workflow.

### Security

- Change-set inspection is fully paginated and fails closed; destructive approvals are scoped per resource; client tokens derive from the full idempotency key.
- `minimatch` pinned to a patched release via pnpm override (dev toolchain advisory).

### Known limitations

See README. Notably: not yet verified against a real AWS account.
