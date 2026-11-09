# mug-agents

Multi-agent system for MongoDB User Group Lisbon. This is **M0**: a NestJS service with typed
domain models, MongoDB persistence, validated config, health checks and tests. No LLM, graph or
external integrations yet (see `specs/M0-skeleton.md`).

## Requirements

- Node.js >= 22.9 (developed on 26; the project is ESM-only because NestJS 12 is ESM-only)
- A MongoDB to run against (local `mongod` is fine). Tests do **not** need one: they start an
  in-memory `mongod` via `mongodb-memory-server` (binary downloaded on first run).

## Run

```bash
npm ci
cp .env.example .env     # then edit if needed
npm run start:build       # build + start (reads .env via node --env-file-if-exists)
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

### Test MongoDB binary (CI)

Integration tests run a real `mongod` through `mongodb-memory-server`, **pinned to 8.0.4**
(`test/support/mongod-version.ts`, mirrored in `package.json` → `config.mongodbMemoryServer.version`;
a unit test keeps them equal). Keep the major in line with the Atlas tier you deploy on, and bump
both places together.

- `npm ci` runs the library's postinstall hook, which downloads the pinned binary (~80 MB) into
  `node_modules/.cache/mongodb-memory-server/`. Set `MONGOMS_DOWNLOAD_DIR=/some/dir` to put it
  elsewhere.
- **Cache it in CI** so builds do not re-download: cache that directory with the pinned version
  in the key, e.g. GitHub Actions
  `path: node_modules/.cache/mongodb-memory-server`, `key: mongod-8.0.4-${{ runner.os }}-${{ runner.arch }}`.
- To pre-download without installing dependencies again, run
  `node node_modules/mongodb-memory-server/postinstall.js` (or any test run; the first one
  downloads on demand, the test hook timeout allows for it).
- Offline/air-gapped runners: set `MONGOMS_DISABLE_POSTINSTALL=1` and point
  `MONGOMS_SYSTEM_BINARY=/path/to/mongod` at a preinstalled binary of the same major.

## Design notes

- **Zod first.** Each entity has `XxxInputSchema`, `XxxSchema` (persisted) and `XxxPatchSchema`;
  types are `z.infer`. Object schemas are `.strict()`.
- **One conversion point.** `src/domain/common.ts` holds the codecs: Mongo stores `Date` and
  `ObjectId`; the domain/API boundary uses ISO strings and 24-char hex ids.
- **Repositories** validate on write and on read (schema drift throws `SchemaDriftError`), use
  keyset pagination on `_id` (`findMany(filter, { limit, sort, after })` → `{ items, nextCursor }`),
  and have **no delete methods** — state changes go through status fields. Filters passed to
  `findMany`/`count` use stored types (`toObjectId`, `Date`).
- **Optimistic locking.** Every document has a `version` (starts at 1, set by the repository).
  `updateById(id, patch, expectedVersion)` only applies if the stored version matches, increments
  it, and otherwise throws `VersionConflictError` (re-read and retry). It returns `null` when the
  id does not exist. Malformed ids return `null` from `findById`/`updateById`; a malformed
  `after` cursor throws `InvalidIdError`.
- **Read-modify-write:** `updateWithRetry(id, mutate, { attempts })` re-reads, applies
  `mutate(doc) => patch` and retries on `VersionConflictError`. Anything that holds a document
  across a pause (LangGraph nodes resumed after `interrupt()`, LLM calls) must use it instead of
  `updateById`. `mutate` must be side-effect free: it can run several times.
- **Schema drift** throws `SchemaDriftError` carrying `documentId`; a paging caller can resume past
  it with `after: err.documentId`.
- **Patches** are shallow: a provided array/object replaces the stored one. Clearing an optional
  field is not supported in M0.
- **Indexes** are ensured at startup (`src/mongo/indexes.ts`); startup fails fast if MongoDB is
  unreachable.
