# mug-agents

Multi-agent system for MongoDB User Group Lisbon. This is **M0**: a NestJS service with typed
domain models, MongoDB persistence, validated config, health checks and tests. No LLM, graph or
external integrations yet (see `specs/M0-skeleton.md`).

## Requirements

- Node.js >= 22 (developed on 26; the project is ESM-only because NestJS 12 is ESM-only)
- A MongoDB to run against (local `mongod` is fine). Tests do **not** need one: they start an
  in-memory `mongod` via `mongodb-memory-server` (binary downloaded on first run).

## Run

```bash
npm ci
cp .env.example .env     # then edit if needed
npm run dev              # build + start (reads .env via node --env-file-if-exists)
```

Or `npm run build && npm start`.

### Environment variables

Validated with Zod at boot (`src/config/env.schema.ts`). Invalid or missing values exit non-zero
with a list of every problem.

| Variable      | Required | Default       | Notes                                                                    |
| ------------- | -------- | ------------- | ------------------------------------------------------------------------ |
| `MONGODB_URI` | yes      | –             | `mongodb://…` or `mongodb+srv://…`                                       |
| `MONGODB_DB`  | yes      | –             | Database name                                                            |
| `NODE_ENV`    | no       | `development` | `development` \| `test` \| `production`                                  |
| `PORT`        | no       | `3000`        |                                                                          |
| `LOG_LEVEL`   | no       | `info`        | `silent` \| `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` |

`process.env` is read only in `src/config/config.module.ts`.

### Health

- `GET /health/live` – 200 while the process is up (never touches MongoDB)
- `GET /health/ready` – 200 when MongoDB answers `ping`, 503 otherwise

## Test and quality

```bash
npm run test:unit   # fast: schemas, config, policy checks
npm test            # everything, including repository/app integration tests
npm run lint
npm run typecheck
npm run build
```

## Design notes

- **Zod first.** Each entity has `XxxInputSchema`, `XxxSchema` (persisted) and `XxxPatchSchema`;
  types are `z.infer`. Object schemas are `.strict()`.
- **One conversion point.** `src/domain/common.ts` holds the codecs: Mongo stores `Date` and
  `ObjectId`; the domain/API boundary uses ISO strings and 24-char hex ids.
- **Repositories** validate on write and on read (schema drift throws `SchemaDriftError`), use
  keyset pagination on `_id` (`findMany(filter, { limit, sort, after })` → `{ items, nextCursor }`),
  and have **no delete methods** — state changes go through status fields. Filters passed to
  `findMany`/`count` use stored types (`toObjectId`, `Date`).
- **Patches** are shallow: a provided array/object replaces the stored one. Clearing an optional
  field is not supported in M0.
- **Indexes** are ensured at startup (`src/mongo/indexes.ts`); startup fails fast if MongoDB is
  unreachable.
