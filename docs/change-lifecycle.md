# Change lifecycle

`REQUESTED → DISCOVERING → ANALYZING → PLANNING → DIFF_READY → VALIDATING → AWAITING_APPROVAL → APPLYING → VERIFYING → COMPLETED`

Alternate states: `NEEDS_INPUT`, `REJECTED`, `STALE_PLAN`, `BLOCKED`, `FAILED`, `PARTIALLY_APPLIED`, `ROLLBACK_REQUIRED`, `CANCELLED`. Illegal transitions throw; every transition is stored and audited.

## Risk (derived from actions, not from the model)

- **blocked**: `delete-stack` — plan stops at `BLOCKED`.
- **elevated**: deletions, IAM expansion, public exposure, data migration, secret rotation, cross-account access, or an irreversible change without backup. Needs an elevated approval from someone other than the requester (and from `elevatedApprovers` if configured).
- **routine**: everything else.

## Approval binding

An approval records plan hash, source revision, environment, account, region, actor and expiry. `authorizeApply` re-checks all of them plus: plan integrity, validation passed, write role configured, live source revision, topology drift, and health gate. Any mismatch of hash/revision/drift moves the change to `STALE_PLAN` and invalidates the approval.

## Apply

Idempotency key = change id + plan hash + account + region + environment; a repeat apply returns the earlier execution. Only transient failures of non-destructive plans are retried (max 2 attempts). The CloudFormation deployer inspects the change set first and refuses removals/replacements the plan did not declare. CloudFormation rollback does not restore data or external side effects; reports say so.

A `metric` criterion can carry a structured `check` (resource, metric, stat, comparator, threshold, window). `changes verify` evaluates it read-only against the last N minutes of telemetry; no datapoints, an unknown resource or a failed query count as not verified. `http` and `test` criteria are still confirmed manually with `--confirm`.

Deployment failure (`FAILED`, `PARTIALLY_APPLIED`) is distinct from verification failure (`ROLLBACK_REQUIRED`: applied but criteria not met).
