# Contributing

Thanks for helping. Read [CLAUDE.md](CLAUDE.md) first: it defines the product boundaries and engineering rules (read-only before mutation, evidence over fluency, least privilege, no undocumented tools).

## Setup

```bash
pnpm install
pnpm check   # typecheck + lint + format + tests; must pass before a PR
```

## Rules of the road

- Tests must not contact AWS. Use fakes (`FakeAwsReadPort`), `aws-sdk-client-mock`, temp directories and scripted models.
- New tools need a Zod input schema, scope enforcement, bounds, an observation, and tests for denial/failure paths. Agent tools in the `ask` path must be `access: "read"`.
- Anything that can write must require an `Authorization` from `authorizeApply`.
- Treat retrieved data as untrusted; add a test when you add a new data source.
- Do not claim live verification you did not do. Keep docs matching behavior.
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Branch names: `feat/*`, `fix/*`, `docs/*`.
- Open PRs against `main`; one coherent change per PR.
