# M0 — Project skeleton

## Decisions taken

- **Repo name** `mug-agents`, single package (no monorepo yet). **Dev DB:** local MongoDB.
- **IDs:** `_id` is `ObjectId` in Mongo, 24-hex string at the boundary; references likewise.
- **Optimistic locking:** persisted documents carry `version` (repo-managed); `updateById` requires `expectedVersion` and throws `VersionConflictError` on mismatch, so concurrent agents cannot silently overwrite each other's array fields.
- **`updateWithRetry(id, mutate, { attempts = 3 })`** on every repository: re-reads, applies `mutate(doc) => patch`, calls `updateById` with the fresh version, retries on `VersionConflictError`, rethrows after the last attempt. **LangGraph nodes resumed after `interrupt()` (and any code that holds a document across a pause, e.g. an LLM call) must use this, not `updateById` directly** — the version they captured before the pause is probably stale. `mutate` runs once per attempt, so it must be side-effect free.
- **Speaker emails are lower-cased** by the schema so the unique index is case-insensitive.
- **Startup failures** are logged as structured JSON (fatal) and the half-started app is closed before exit; config errors stay plain readable text.
- **Patch semantics:** shallow; provided arrays/objects replace stored ones. Clearing an optional field is not supported yet.
- **Zod codecs for the storage boundary.** `entityId` and `isoDate` in `domain/common.ts` are `z.codec`s (Mongo type in, domain type out), so `z.infer` is the string-based domain type and `toStorage` / `fromStorage` (`z.encode` / `z.safeDecode`) are the only conversion points.
- **Schemas have required arrays** (`coHostOrganisationIds`, `agenda`, `topics`, `links`, `perEvent`, `contacts`, `history`) – no defaults, so Input and output types stay identical.
- **`Task.source` is immutable** (omitted from `TaskPatch`); no other field is immutable.
- **Keyset pagination:** `findMany(filter, { limit, sort: 'asc'|'desc', after })` returns `{ items, nextCursor }`; ordering is always by `_id`; limit clamped to 1..200 (default 50).
- **Logging:** pino behind `AppLogger` (Nest `LoggerService`) in `src/logging/`; call sites use Nest's `Logger`. Added `silent` as a log level for tests.
- **Test DB: `mongodb-memory-server`** over testcontainers: no Docker needed on dev machines or CI, starts in ~1s after the first binary download, and still gives a real `mongod` (unique indexes, `findOneAndUpdate`, server selection). One `mongod` per run (vitest `globalSetup`), a uniquely named database per test file, dropped afterwards.
- **No delete anywhere:** enforced by a unit test that scans `src/`.
- **Start/dev scripts** use `node --env-file-if-exists=.env` – no dotenv dependency, and `process.env` is still only read in the config module.

## Ambiguous in the spec

- Whether Input schemas should have defaults for array fields (chose: no).
- Which fields are "immutable" for Patch (chose: only `Task.source`).
- Shape of `sort` in `findMany` (chose: direction on `_id` only, to keep keyset pagination valid).
- `speakers.email` unique+sparse: the repository never writes `null`/`undefined` for absent optionals so sparse works.

## Installed versions that differed from expectations

- **NestJS 12.4 is ESM-only** (`"type": "module"`): the project is ESM (`module: NodeNext`, `.js` import suffixes). `abortOnError: false` is used so startup errors reach `main.ts`'s catch and exit with code 1.
- **esbuild-based runners (tsx) do not emit decorator metadata**, so the dev script runs the `tsc` build; Vitest uses `unplugin-swc` for `emitDecoratorMetadata`.
- **Terminus 12:** custom indicators use `HealthIndicatorService.check(key).attempt(fn).withTimeout(ms)` (checked in the `.d.ts`), not the old `HealthIndicator` base class.
- **Zod 4.6:** `z.codec`, `z.encode`, `z.safeDecode`, `z.iso.datetime`, `z.email()`, `z.url()` – verified by running them; `.extend` / `.partial` keep `.strict()`.
- **mongodb 7.8:** `findOneAndUpdate` returns the document (or null) directly.
- **TypeScript 6.0.3, ESLint 10 (flat config), Vitest 5.1** (`projects` for unit/integration split).
- Node here is v26 (not LTS); `engines` says `>=22.9` (needed for `--env-file-if-exists`).
