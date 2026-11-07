# Terraform and other IaC through an isolated worker

Cloud Agent never runs `terraform`, `tofu` or `terragrunt` in its own process: `terraform init` downloads and executes provider code, so it must run in an ephemeral, least-privilege worker. The local validator refuses Terraform plans for that reason.

The supported path is `changes validate --codebuild <project>`: `CodeBuildValidator` starts a build of **your** CodeBuild project, pinned to the plan's source revision, passing only the change id and plan hash. What the build does is defined by the `buildspec.yml` in your repository, so Terraform support is a buildspec you own and review. Example:

```yaml
version: 0.2
phases:
  install:
    commands:
      - terraform version
  build:
    commands:
      - terraform init -input=false -lockfile=readonly
      - terraform validate
      - terraform plan -input=false -lock=false -out=tfplan
      - terraform show -no-color tfplan > plan.txt
      # Fail the build if the plan destroys or replaces anything the change did not declare.
      - '! grep -E "must be replaced|will be destroyed" plan.txt'
```

Guidance:

- Give the CodeBuild service role read-only access to the target account (plus state read access). It needs no write access: `plan` does not apply.
- Use `-lockfile=readonly` and pin provider versions so the build cannot silently pick up new provider code.
- The build result (pass/fail and phase summary) becomes the validation report; the plan text stays in your build logs.
- Applying Terraform is not implemented. Approved changes reach your repository through the branch/PR deployer, and your normal pipeline applies them.

Status: implemented, not verified live (the CodeBuild path is tested with mocks).
