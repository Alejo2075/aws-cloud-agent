# Hosted deployment foundation

Status: **implemented, not verified live.** Nothing here has been deployed or run against a real AWS account. The tests use mocks and local CDK synthesis only.

## What exists

- `packages/stores-aws`: DynamoDB and S3 implementations of the storage seams.
  - `DynamoDbChangeStore`: one item per change; global index `byIdempotencyKey`; refuses records near the 400 KB item limit.
  - `DynamoDbAuditLog`: hash-chained, appended with a conditional write on the next sequence number so writers cannot fork the chain; gives up after bounded retries instead of writing out of order.
  - `S3GraphStore`, `S3EvidenceStore`: server-side encrypted objects; account, region, system and environment are part of the key so IAM can scope by prefix. Evidence is redacted before it is written.
- `infra/`: a CDK stack (`CloudAgentStack`) with the two tables, a private TLS-only versioned bucket (all retained on deletion, point-in-time recovery on) and a read-only role that lists only list/describe/get actions. Log content, Cost Explorer and CloudTrail are intentionally not granted; add them only with the matching consent flags.

## What does not exist yet

- An API Lambda wired to the stores, and an identity provider (JWT authorizer) for `apps/api`. `apps/api` takes a `Principal`; the integration that produces it is yours to provide.
- A write role. Deployers need a separate, narrowly scoped role per target; none is created here.
- Retention and deletion jobs for old evidence and audit data.

## Using it

The stack is synthesized locally by the tests (`pnpm test`). Deploying it is a decision for the account owner: review the synthesized template first, use a test account, and treat it as unverified.
