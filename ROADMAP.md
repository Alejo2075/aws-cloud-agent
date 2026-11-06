# Roadmap

Done in v0.1.0: M0 foundation, M1 read-only understanding, M2 operational intelligence, M3 controlled changes (see CHANGELOG).

Next, in priority order:

1. **Live verification** in an isolated test account (explicit opt-in): discovery, `ask`, plan → apply → verify on a sample app.
2. Health gate (alarms/stack status) and configuration-level drift detection.
3. Branch/PR adapter and automatic patch application for source changes; isolated CodeBuild validation workers.
4. More resource coverage (REST API, Step Functions, ECS, RDS, Kinesis) and X-Ray.
5. Terraform plan adapter.
6. Plugin loading for third-party tools and connection providers; EventBridge lifecycle events.
7. Hosted API (`apps/api`) and a CDK stack for Cloud Agent itself, with DynamoDB/S3 stores.
