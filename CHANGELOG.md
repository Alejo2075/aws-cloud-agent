# Changelog

All notable changes are documented here. Format based on Keep a Changelog; versioning follows SemVer (0.x: minor versions may break).

## [0.1.0] - 2026-11-06 (prerelease)

### Added

- Read-only discovery, System Graph with provenance, evidence store, redaction, hash-chained audit log.
- Bedrock-backed `ask` with citation validation; metrics, logs, deployment history, cost, repository and IaC tools.
- `CloudSystemManifest` v1 import, JSON Schema and reconciliation.
- Change planning, plan-hash-bound approvals, policy gates, state machine, local validation runner, CloudFormation change-set deployer, `plan` / `changes` commands.

### Known limitations

See README. Notably: not yet verified against a real AWS account.
