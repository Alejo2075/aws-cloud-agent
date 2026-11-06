# Progress

Source of truth for scope and order: `CLAUDE.md`. Constraint from the owner: **no live AWS calls and no deployments** to their account; everything is verified with fixtures, `aws-sdk-client-mock` and local synth only.

Branch: `feat/foundation` (pushed). Last verified: typecheck, lint, format and 75 tests passing locally.

## Done (v0.1.0 prerelease candidate)

- **M0**: pnpm workspace, strict TS (6.0.x), ESLint, Prettier, Vitest, CI, contracts, deny-by-default scope evaluation.
- **M1**: scoped read-only discovery, System Graph with provenance, evidence + redaction, hash-chained audit, manifest import/reconcile + JSON Schema, Bedrock `ask` with citation validation, CLI.
- **M2**: bounded metrics, logs (consent-gated), deployment history, cost by tag (consent-gated), repository/IaC inspection, source mapping.
- **M3**: change plans with derived risk + hash, state machine, plan-bound approvals, policy gate (branded Authorization), idempotent apply, local validation runner, CloudFormation change-set deployer (fully paginated, per-resource destructive scoping), `plan` / `changes *` CLI. A post-commit security review found three deployer issues; all fixed with tests.
- **Docs/community**: Apache-2.0 LICENSE, README, architecture, security model (+ example read-only IAM policy), change lifecycle, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, ROADMAP, issue/PR templates, dependabot.

Last verified locally: typecheck, lint, format, 106 tests passing.

## Not done (see ROADMAP.md)

Live verification in a test account; health gate and config-level drift; branch/PR adapter and patch application; CodeBuild isolated workers; Terraform adapter; plugin loader and lifecycle events; `apps/api`; CDK stack for Cloud Agent itself; more resource types.

## Not verified

Nothing has run against a real AWS account, Bedrock, CodeBuild or CloudFormation. The owner asked that no live AWS calls be made during development.
