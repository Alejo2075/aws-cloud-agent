# Progress

Source of truth for scope and order: `CLAUDE.md`. Mutation workflows (M3) are not started and must not be until M1 read-only scoping, evidence attribution and graph quality work.

## M0 — Foundation

- [x] pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest, CI workflow
- [x] `@cloud-agent/contracts`: scope, connection profile, evidence, graph schemas (Zod)
- [x] `@cloud-agent/connections`: deny-by-default scope evaluation (tested)
- [ ] CLI skeleton (`connect`, `systems inspect`, `ask`)
- [ ] AWS read-only tool interfaces (`tools-aws`)
- [ ] LICENSE, README, CONTRIBUTING, SECURITY (license awaiting owner decision)

## Not verified

No live AWS access has been exercised; nothing here has run against a real account.
