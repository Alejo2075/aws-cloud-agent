# Changelog

All notable changes are documented here. Format based on Keep a Changelog; versioning follows SemVer (0.x: minor versions may break).

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
