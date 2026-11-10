# mug-agents

Multi-agent system for MongoDB User Group Lisbon. **M0** is the NestJS service with typed domain
models, MongoDB persistence, validated config, health checks and tests (`specs/M0-skeleton.md`).
**M1** adds the first model call: an event planner graph (see [Event planner](#event-planner-m1)).
No external integrations yet.

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

| Variable                 | Required            | Default                                                       | Notes                                                                                                        |
| ------------------------ | ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`            | yes                 | –                                                             | `mongodb://…` or `mongodb+srv://…`                                                                           |
| `MONGODB_DB`             | yes                 | –                                                             | Database name                                                                                                |
| `NODE_ENV`               | no                  | `development`                                                 | `development` \| `test` \| `production`                                                                      |
| `PORT`                   | no                  | `3000`                                                        |                                                                                                              |
| `LOG_LEVEL`              | no                  | `info`                                                        | `silent` \| `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`                                     |
| `OLLAMA_BASE_URL`        | no                  | `https://ollama.com/v1`                                       | OpenAI-compatible endpoint                                                                                   |
| `OLLAMA_API_KEY`         | at first model call | –                                                             | **Secret.** Not required at boot or for `npm test`                                                           |
| `OLLAMA_MAX_CONCURRENCY` | no                  | `3`                                                           | Provider limit, not a tuning knob                                                                            |
| `LLM_MODEL_LADDER`       | no                  | `ollama:gemma4:31b,ollama:gpt-oss:20b,ollama:mistral-large-4` | Ordered rungs; unknown provider or duplicates rejected                                                       |
| `LLM_PRICES`             | no                  | `{}`                                                          | JSON map model ref → `{inputPerMTok, outputPerMTok}`                                                         |
| `LLM_TIMEOUT_MS`         | no                  | `60000`                                                       | Per provider call                                                                                            |
| `LLM_MAX_ATTEMPTS`       | no                  | 2 × ladder length                                             | Total provider calls per structured call; must let every rung be reached (3 rungs need ≥ 5), else boot fails |

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

## Event planner (M1)

Given an event brief, the planner produces a validated timeline and checklist, persists them as
`Task` documents linked to an `Event`, and can be measured across models.

```
normaliseBrief (code) -> generateTimeline (model) -> generateChecklist (model)   [LangGraph StateGraph]
```

The model never computes dates and never invents ids: milestone dates come from the event date in
code (`src/agents/planner/timeline.ts`), and every task's `dueAt` is its milestone's date. LLM output
is validated by strict Zod schemas (`llm-schemas.ts`) that have no id, version or date fields.

### Ollama Cloud setup

There is no local model: one provider, Ollama Cloud (`https://ollama.com/v1`, OpenAI-compatible).

1. Create an API key at <https://ollama.com/settings/keys> (needs an Ollama account/plan).
2. Put it in `.env` (never commit it): `OLLAMA_API_KEY=...`. It is only required when a model call
   is attempted, so `npm test` and the unit suite need no key and no network.
3. List what your account can use: `curl -s https://ollama.com/api/tags -H "Authorization: Bearer $OLLAMA_API_KEY"`.
   Use the names it returns (e.g. `gemma4:31b`), not the `:cloud` suffix used by the local daemon.

### The model ladder

`LLM_MODEL_LADDER` is an ordered, comma-separated list of `provider:model` refs, cheapest first:

```
LLM_MODEL_LADDER=ollama:gemma4:31b,ollama:gpt-oss:20b,ollama:mistral-large-4
```

The default order comes from the first eval (`evals/report-2026-11-10.md`): `gemma4:31b` was the
fastest and most reliable, `gpt-oss:20b` is a cheap second opinion from a different model family,
and `mistral-large-4` is a last resort (slow: some calls hit the 60 s timeout).

On a validation failure the planner retries the same model once with the issues appended, then
moves to the next rung (`ATTEMPTS_PER_RUNG` = 2 calls per rung). `LLM_MAX_ATTEMPTS` is the total
number of provider calls; it defaults to 2 × the ladder length, and boot **fails** if it is too small for
every rung to be reachable (3 rungs need at least 5), naming the unreachable rungs. A ladder of one
means no escalation. The provider is an abstraction (`src/llm/model.types.ts`); only `ollama` is
configured, so adding a vendor is a new provider class plus an env-var change.

**Accepted consequence of a single provider:** all rungs share one failure domain. Climbing helps when
the _model_ is the problem (it cannot hold the schema), not when the _provider_ is. On an outage, an
auth failure or a queue that stays full, the run aborts with `ProviderUnavailableError`, writes
nothing and never touches the next rung; it is reported separately from `StructuredOutputError`
(validation failure) in logs and in the eval report.

`OLLAMA_MAX_CONCURRENCY` (default 3) is the provider's limit, enforced by one process-wide semaphore.
`LLM_PRICES` is a JSON map of model ref to `{inputPerMTok, outputPerMTok}` used only for cost
accounting; prices are never hard-coded.

> Ollama Cloud currently **ignores** schema-constrained decoding (`format` / `response_format`): the
> schema goes into the prompt and the retry policy is load-bearing. See `docs/m1-pr-description.md`
> for the probe, and `scripts/probe-format.mjs` to re-test it.

### Run the planner

```bash
LOG_LEVEL=warn npm run plan -- --brief examples/brief.json
```

Edit the `date` in `examples/brief.json` if it has passed (a past date is rejected before any model
call). It prints the timeline and checklist and writes the Event and Tasks to MongoDB
(`MONGODB_URI`). Running it again on the same brief says "already planned" and does not call the
model or write anything (a model rarely repeats its wording exactly, so a title-only check would add a
second copy of the checklist). `--replan` generates again and adds only task titles that do not
exist yet; nothing is ever deleted.

Idempotency key for tasks: `(relatedEventId, milestoneKey, normalised title)` (case and whitespace
ignored), checked before insert. The event is matched by `brief.eventId` if given, otherwise by
same day + same theme.

### Run the evals

```bash
npm run eval -- --models ollama:gemma4:31b,ollama:gpt-oss:20b,ollama:mistral-large-4
```

Calls the real provider (spends credits; not part of `npm test`). Writes `evals/report-<date>.md`.
See `evals/README.md`.

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
