# Roadmap

Done: M0 foundation, M1 read-only understanding, M2 operational intelligence, M3 controlled changes (v0.1.0); stack health gate, config drift, CodeBuild validator, lifecycle events, tool registry (v0.2.0); branch/PR deployer, HTTP API handlers, plugin loader, alarm gate, Step Functions and Kinesis (v0.3.0). See CHANGELOG.

Next, in priority order:

1. **Live verification** in an isolated test account (explicit opt-in from the account owner): discovery, `ask`, plan → apply → verify on a sample app. Nothing in this repository has been run against real AWS yet.
2. Hosted deployment: stores and a CDK stack exist (unverified live); still missing are the API Lambda wiring, an identity provider integration for `apps/api`, and retention jobs. See docs/hosted-deployment.md.
3. SLO-based health checks and automatic verification of metric and HTTP criteria (done, unreleased); full SLO objects remain.
4. More resource coverage (metrics for REST API, RDS clusters, X-Ray); Terraform plan support is documented through an isolated CodeBuild worker (docs/terraform.md).
5. Plugin sandboxing (out-of-process plugins) and connection providers.
