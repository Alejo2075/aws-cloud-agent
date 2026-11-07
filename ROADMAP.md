# Roadmap

Done: M0 foundation, M1 read-only understanding, M2 operational intelligence, M3 controlled changes (v0.1.0); stack health gate, config drift, CodeBuild validator, lifecycle events, tool registry (v0.2.0); branch/PR deployer, HTTP API handlers, plugin loader, alarm gate, Step Functions and Kinesis (v0.3.0). See CHANGELOG.

Next, in priority order:

1. **Live verification** in an isolated test account (explicit opt-in from the account owner): discovery, `ask`, plan → apply → verify on a sample app. Nothing in this repository has been run against real AWS yet.
2. Hosted deployment: DynamoDB/S3-backed stores, an identity provider integration for `apps/api`, and a CDK stack for Cloud Agent itself.
3. SLO-based health checks and automatic verification of HTTP criteria (metric criteria are automated; unreleased).
4. More resource coverage (metrics for REST API and ECS, RDS clusters, X-Ray) and Terraform plan support through an isolated worker.
5. Plugin sandboxing (out-of-process plugins) and connection providers.
