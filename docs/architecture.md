# Architecture

```text
CLI ──► policy/scope ──► agent (read-only tools) ──► System Graph + evidence ──► answer
                    └─► change service ──► plan ─► validate ─► approval ─► policy.authorizeApply ─► deployer ─► verify
                                     every step ──► hash-chained audit log
```

## Principles enforced in code

- **Read/write separation.** `AwsReadPort` and `ObservabilityPort` expose only list/describe/get operations. The only writer is a `Deployer`, which requires an `Authorization` that only `authorizeApply` can mint (branded type).
- **Deny-by-default scope.** `evaluateScope` requires a stack, ARN or tag selector match _and_ the connection's account and region. Discovery only describes in-scope resources and reports everything else as a gap.
- **Untrusted data.** Tool results, logs and repository text are redacted, size-bounded and wrapped in `<untrusted>` markers before reaching the model. The model can only call registered tools; authorization never depends on model output.
- **Evidence.** Each tool call records an `Observation` with source, resource, time range and confidence; answers may cite only observations produced in the same run. Missing access is reported as a limitation, never filled in.
- **Provenance.** Graph edges are `discovery` or `inferred` (inferred edges, such as environment-variable references, say why). Env var values are matched locally and never persisted.

## Packages

| Package       | Responsibility                                                        |
| ------------- | --------------------------------------------------------------------- |
| `contracts`   | Zod schemas: scope, connection, evidence, graph, source refs          |
| `connections` | Scope evaluation                                                      |
| `tools-aws`   | Read ports, SDK adapters, ARN helpers, metric catalog and bounds      |
| `discovery`   | Bounded, concurrent discovery producing a `SystemGraph`               |
| `graph`       | Stores (memory, file), queries, impact analysis, topology fingerprint |
| `evidence`    | Redaction, freshness, evidence stores, audit log                      |
| `manifest`    | `CloudSystemManifest` parse, schema, reconciliation                   |
| `tools-git`   | Safe read-only repo access, IaC detection, source mapping             |
| `agent`       | Tool contracts, ask loop, planner, Bedrock port                       |
| `changes`     | Plan hashing, risk, state machine, policy, service, stores            |
| `validation`  | Allowlisted command runner in a throwaway copy                        |
| `deployments` | CloudFormation change-set deployer                                    |

## Storage

State is local files (`~/.cloud-agent`), keyed by account/region/system/environment. Stores are behind interfaces (`GraphStore`, `EvidenceStore`, `ChangeStore`, `AuditLog`) so DynamoDB/S3 implementations can be added.
