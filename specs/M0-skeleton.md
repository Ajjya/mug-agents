# M0 — Project skeleton (spec for Claude Code)

Project: mug-agents — multi-agent system for MongoDB User Group Lisbon. Milestone: M0.

The full original spec was provided in chat; this file records the decisions made against it.
Key points: NestJS + Zod + native `mongodb` driver (no ODM), Vitest, ESLint + Prettier, npm;
strict TS (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`);
Zod-first domain models (Input / Document / Patch, `.strict()`), repositories with validate-on-write
and validate-on-read, keyset pagination, no delete methods; fail-fast Mongo module with idempotent
`ensureIndexes()`; Zod-validated env; structured JSON logging; Terminus `/health/live` and
`/health/ready`; unit + integration tests. Out of scope: LangGraph/LangChain, model calls,
Gmail/Meetup/Telegram/LinkedIn, RAG, auth, Docker, approval flow.

See `docs/m0-pr-description.md` for decisions and deviations.
