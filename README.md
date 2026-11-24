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

| Variable                                          | Required            | Default                                                       | Notes                                                                                                        |
| ------------------------------------------------- | ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`                                     | yes                 | –                                                             | `mongodb://…` or `mongodb+srv://…`                                                                           |
| `MONGODB_DB`                                      | yes                 | –                                                             | Database name                                                                                                |
| `NODE_ENV`                                        | no                  | `development`                                                 | `development` \| `test` \| `production`                                                                      |
| `PORT`                                            | no                  | `3000`                                                        |                                                                                                              |
| `LOG_LEVEL`                                       | no                  | `info`                                                        | `silent` \| `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`                                     |
| `OLLAMA_BASE_URL`                                 | no                  | `https://ollama.com/v1`                                       | OpenAI-compatible endpoint                                                                                   |
| `OLLAMA_API_KEY`                                  | at first model call | –                                                             | **Secret.** Not required at boot or for `npm test`                                                           |
| `OLLAMA_MAX_CONCURRENCY`                          | no                  | `3`                                                           | Provider limit, not a tuning knob                                                                            |
| `LLM_MODEL_LADDER`                                | no                  | `ollama:gemma4:31b,ollama:gpt-oss:20b,ollama:mistral-large-4` | Ordered rungs; unknown provider or duplicates rejected                                                       |
| `LLM_PRICES`                                      | no                  | `{}`                                                          | JSON map model ref → `{inputPerMTok, outputPerMTok}`                                                         |
| `LLM_TIMEOUT_MS`                                  | no                  | `60000`                                                       | Per provider call                                                                                            |
| `CHECKPOINT_TTL_DAYS`                             | no                  | `30`                                                          | Days a finished thread's checkpoints are kept; paused/failed threads never expire                            |
| `APPROVER_NAME`                                   | no                  | OS user                                                       | Recorded as the decider when `approvals` has no `--by`                                                       |
| `OLLAMA_LOCAL_BASE_URL`                           | no                  | `http://127.0.0.1:11434`                                      | Local Ollama, for embeddings only                                                                            |
| `EMBEDDING_MODEL`                                 | no                  | `nomic-embed-text`                                            | Local embedding model; recorded on every chunk                                                               |
| `EVAL_EMBEDDERS`                                  | no                  | `ollama-local:<EMBEDDING_MODEL>`                              | Embedders the retrieval eval compares                                                                        |
| `RETRIEVAL_STORE`                                 | no                  | `bruteforce`                                                  | `bruteforce` or `atlas`                                                                                      |
| `ATLAS_LOCAL_URI`                                 | no                  | –                                                             | mongodb-atlas-local, for the Atlas arm of tests and eval                                                     |
| `VECTOR_MIN_SCORE`                                | no                  | `0.575`                                                       | Cosine below this is not relevant (calibrated on the sample)                                                 |
| `VECTOR_MIN_GAP`                                  | no                  | `0.05`                                                        | Scale-free vector gate: top cosine minus the median of the retrieved set                                     |
| `KEYWORD_MIN_COVERAGE`                            | no                  | `0.5`                                                         | Keyword arm: share of the query's distinct terms a chunk must contain                                        |
| `CHASE_MAX_ROUNDS`                                | no                  | `2`                                                           | Sent chases of one kind per speaker per event before a task replaces the next message                        |
| `CHASE_MIN_INTERVAL_DAYS`                         | no                  | `7`                                                           | Days after the last sent message before the next chase is due                                                |
| `MAX_DRAFTS_PER_RUN`                              | no                  | `10`                                                          | Drafts one `speakers run` may write; the rest wait for the next run                                          |
| `EVENT_TIME_ZONE`                                 | no                  | `Europe/Lisbon`                                               | Time zone event and slot times are written in, in drafts                                                     |
| `GMAIL_LABEL`                                     | to start the inbox  | –                                                             | Admits mail: bodies read, triaged, linked. No default; must differ from the candidate label                  |
| `GMAIL_CANDIDATE_LABEL`                           | to start the inbox  | –                                                             | Metadata only: nothing but headers is ever fetched. No default                                               |
| `IMAP_USER` / `IMAP_APP_PASSWORD`                 | to read Gmail       | –                                                             | A Gmail address and an **app password** (see Inbox). Secrets: never logged, never in an error                |
| `IMAP_HOST` / `IMAP_PORT`                         | no                  | `imap.gmail.com` / `993`                                      | The IMAP server (TLS)                                                                                        |
| `TRIAGE_START_MODEL`                              | no                  | `ollama:gpt-oss:20b`                                          | Ladder rung triage starts on (must be in `LLM_MODEL_LADDER`)                                                 |
| `INBOX_DOCUMENT_SHARE_SENDERS`                    | no                  | Google drive/docs notification senders                        | Addresses or `@domain`, comma-separated: mail from them is `document_share`, decided in code with no model   |
| `TRIAGE_MAX_CHARS`                                | no                  | `6000`                                                        | Bound on the redacted text a triage prompt carries (cut from the end, with a marker)                         |
| `GMAIL_SWEEP_MAX_PAGES` / `GMAIL_SWEEP_PAGE_SIZE` | no                  | `20` / `200`                                                  | UIDs read per page, and pages per folder per poll: bounds a first backfill and a UIDVALIDITY re-sweep        |
| `LLM_MAX_ATTEMPTS`                                | no                  | 2 × ladder length                                             | Total provider calls per structured call; must let every rung be reached (3 rungs need ≥ 5), else boot fails |

`process.env` is read only in `src/config/config.module.ts`.

### Health

- `GET /health/live` – 200 while the process is up (never touches MongoDB)
- `GET /health/ready` – 200 when MongoDB answers `ping`, 503 otherwise

## Test and quality

```bash
npm run test:unit      # no network, no mongod: schemas, decisions, drafting, the workflow suite in memory
npm test               # + integration: a real mongod (see below); needs the network ONLY on a cold cache
npm run verify         # typecheck + lint + npm test: what a "clean" claim means
npm run test:prepare   # download the pinned mongod now (idempotent), so a later run is offline
npm run build
```

### Test MongoDB binary: what needs the network

**The integration suite downloads a `mongod` (~80 MB) the first time, if it is not cached.** After
that, `npm test` needs no network. Nothing in the suite calls Ollama, Docker or a model: models are
scripted, and the embedder is stubbed. The `unit` project never starts a `mongod`.

Integration tests run a real `mongod` through `mongodb-memory-server`, **pinned to 8.0.4**
(`test/support/mongod-version.ts`, mirrored in `package.json` → `config.mongodbMemoryServer.version`;
a unit test keeps them equal). Keep the major in line with the Atlas tier you deploy on, and bump
both places together.

- **Where it is cached.** `MONGOMS_DOWNLOAD_DIR=/some/dir` chooses the directory. Without it, the
  installed library (11.3.0) also looks in `~/.cache/mongodb-binaries/` (where it was found here),
  so a machine that has run the tests before is warm.
- **Warm it deliberately:** `npm run test:prepare` (the library's own postinstall step: it reads
  the pinned version from `package.json`, and does nothing if the binary is already there).
  `npm ci` runs the same step.
- **Cache that directory in CI**, with the version in the key, e.g. GitHub Actions (there is no CI
  config in this repository yet, so this is the step to add, not one that exists):

  ```yaml
  env:
    MONGOMS_DOWNLOAD_DIR: ${{ github.workspace }}/.mongod-cache
  steps:
    - uses: actions/cache@v4
      with:
        path: .mongod-cache
        key: mongod-8.0.4-${{ runner.os }}-${{ runner.arch }}
    - run: npm ci && npm run test:prepare && npm run verify
  ```

- **Offline or air-gapped runners:** pre-populate `MONGOMS_DOWNLOAD_DIR`, or set
  `MONGOMS_DISABLE_POSTINSTALL=1` and `MONGOMS_SYSTEM_BINARY=/path/to/mongod` (same major).
- **How the "offline once warm" claim was checked** (2026-11-17, macOS arm64): with `HOME` pointing at
  an empty directory, `MONGOMS_DOWNLOAD_DIR` at a copy of the cached binary and
  `MONGOMS_DOWNLOAD_MIRROR=http://127.0.0.1:9` (nothing listens), `npx vitest run --project integration`
  passed (10 files, 243 tests), and `npm run test:prepare` found the binary and did nothing. With an
  empty cache directory and the same unreachable mirror, resolving the binary failed, because it tried
  to download. Re-check it the same way after changing the pinned version.

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
call). Since M2 the planner **pauses**: it prints the timeline and the proposed checklist and waits for
a human decision; **no tasks are written until you approve** (see [Approval workflow](#approval-workflow-m2)).
Only the Event (phase `planning`) is written up front, because the paused thread hangs off it.

Planning an event that already has a plan waiting does not start a second run; one that already has
agent-created tasks says "already planned" and calls no model (a model rarely repeats its wording, so a
title-only check would add a second copy). `--replan` plans again and adds only task titles that do not
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

### Resetting the development database

```bash
npm run reset-dev-db
```

Drops the database named by `MONGODB_DB` and prints each collection and how many documents it held.
It refuses to run when `NODE_ENV` is `production` or when `MONGODB_DB` does not end in `_dev`, so
name your development database accordingly (e.g. `mug_agents_dev`). Indexes are recreated on the next
app start.

**The no-delete policy** (repositories expose no delete method; agents change state through status
fields) governs **agent behaviour and domain data**. It does not govern an operator's explicit reset:
this script lives outside `src/`, is not reachable from the app or any agent, and is a deliberate
human action.

## Approval workflow (M2)

The planner graph can pause for a human decision and resume later, in a different process, with its
state intact. It still sends nothing anywhere.

```
normaliseBrief -> generateTimeline -> generateChecklist -> requestPlanApproval -> persistPlan   (approve / edit)
                                                                               -> recordRejection (reject)
```

```bash
npm run plan -- --brief examples/brief.json     # runs to the approval point and stops
npm run approvals -- list                       # pending requests (orphans flagged) + resumable threads
npm run approvals -- show <id>                  # the plan under review, readable (--json for the payload)
npm run approvals -- approve <id> [--by name]   # resume and persist the plan
npm run approvals -- edit <id> --file edited.json
npm run approvals -- reject <id> --reason "..." # a reason is mandatory
npm run approvals -- resume <threadId>          # continue a stopped thread
```

- A decision is `approve | edit | reject`, never a boolean. `edit` takes the corrected plan (start from
  `show <id> --json`); it is validated against the same schema as the interrupt payload **before** the
  graph resumes, and it may change goals, work items and the checklist but not what code computed (the
  event, the theme, milestone keys, labels or dates). `reject` persists no tasks and records the reason
  on the event; the phase stays `planning`.
- Every request and decision is persisted (`approval_requests`, `approval_decisions`) and never deleted;
  `expired` is a status. Deciding a request twice is an error. `--by`, else `APPROVER_NAME`, else your OS
  user name is recorded as the decider, as given (there is no authentication yet).
- **A run that dies on a provider failure is not lost.** The thread keeps its state at the last
  completed node. `approvals list` shows it under RESUMABLE THREADS with the node that failed;
  `approvals resume <threadId>` re-runs only that node (completed nodes, and the milestones computed
  by `normaliseBrief`, are not repeated).
- **Orphans.** The approval request is written _before_ the thread suspends, so a crash between the two
  leaves a pending request whose thread is not waiting. `approvals list` marks it `ORPHAN` and it cannot
  be decided; `approvals resume <threadId>` re-runs the node, which reuses its request (one request per
  thread, run and node, enforced by a unique index) and suspends.
- **Threads.** One thread per event and purpose, `event:<eventId>:plan` (`src/graph/thread.ts`, parsed
  only there). Planning an event whose thread is waiting continues it; one that stopped is continued;
  a second thread for the same purpose cannot be built.
- **One run per thread at a time, across processes**: a lease in `graph_locks` (released by expiring
  it, 15-minute lifetime for a crashed holder). A second `plan`/`resume`/decision on a thread that is
  running elsewhere gets "is being run by another process"; `approvals list` shows such threads under
  RUNNING NOW.
- Commands that start nothing (the plan is waiting, stopped, or already planned) do not write to the
  event; a re-plan keeps earlier `Plan rejected: ...` notes.
- Every graph node is safe to re-run: LangGraph re-executes an interrupted node from its start on
  resume (verified on the installed version). The approval node's request write is idempotent and
  `persistPlan` uses the M1 natural-key check.

### Autonomy policy

One table, `src/approvals/autonomy.ts`, enforced in code at the service boundary by
`requireAutonomy(action)`. A node cannot opt out and the model is never asked whether something needs
approval. Adding an action without an entry fails the build; `never` cannot be bypassed by any flag,
argument, environment variable or config value.

| Action                     | Level                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| `draft_internal_note`      | auto                                                              |
| `create_task`              | auto                                                              |
| `plan_review`              | approve                                                           |
| `send_external_message`    | approve (nothing sends yet: the entry exists so M4/M5 inherit it) |
| `delete_anything`          | never                                                             |
| `draft_speaker_message`    | auto                                                              |
| `chase_in_existing_thread` | auto (a sent message exists; the chase limit is enforced)         |
| `thank_you_message`        | auto                                                              |

### Checkpoints: operational data, and retention

Checkpoints are **operational data**, not domain data. The no-delete rule governs agent behaviour and
domain data (events, tasks, approvals); checkpoints are the exception because they must be bounded.

- The official `@langchain/langgraph-checkpoint-mongodb` saver runs on the application's one
  `MongoClient` (no second client), in `graph_checkpoints` and `graph_checkpoint_writes`. Their indexes
  are declared in `src/mongo/indexes.ts` and created by `ensureIndexes()` at startup.
- **Retention, `CHECKPOINT_TTL_DAYS` (default 30):** when a thread _completes_ (finished or rejected) it
  is stamped with `expire_at = now + TTL`; a MongoDB TTL index on `expire_at` removes those documents.
  Threads that are paused or stopped never get the stamp, so they are never removed: a thread paused
  for two months still resumes. The package's own `ttl` option is not used because it expires each
  document by its own age, which would delete a paused thread's latest checkpoint. There is no
  delete code in `src/`; MongoDB does the removal, so the no-delete test is untouched.
- `npm run reset-dev-db` drops checkpoint state too, and its output names the unfinished threads it
  discarded.

## Retrieval over MUG's own history (M3)

Searches past event pages, posts, talk abstracts and notes, and suggests speakers with citations.
Retrieval only: no long-term memory store, no Speakers agent yet (see `docs/m3-pr-description.md`).

### Corpus and speakers

The corpus is files, not APIs: `corpus/sample/` (committed, **fictional**) and `corpus/private/` (the
real material, git-ignored). Layout and the `manifest.json` format are in [corpus/README.md](corpus/README.md).
Ingestion fails on a file without a manifest entry, an entry without a file, or a missing classification.

```bash
npm run seed-speakers -- --corpus corpus/sample   # idempotent by handle; seeds BEFORE ingest
npm run seed-organisations -- --corpus corpus/sample   # venues, sponsors, groups; idempotent by (name, kind)
npm run ingest -- --corpus corpus/sample          # chunks + local embeddings; writes chunks only
```

Speakers are seeded by hand from `speakers.seed.json` (no emails in git), never extracted from the
corpus by a model. Ingestion only _reads_ speakers (to stamp `speakerId` on their chunks) and never
creates or changes a speaker, event or organisation.

### Embeddings: local, always

`ollama serve` must be running wherever the service runs: it is needed for every query, not just at
ingest. Generation stays on Ollama Cloud; embeddings never leave the machine.

```bash
ollama serve &              # if the desktop app is not already running it
ollama pull nomic-embed-text
```

`nomic-embed-text` returns 768-dimensional vectors; its effective context on the installed tag is
**2048 tokens** (longer input is refused), so chunks are capped at about 1000 tokens. Every chunk records
its model and dimension, and a query from a different model or dimension is refused.

### Search and speaker suggestions

```bash
npm run search -- "change streams" [--kind abstract] [--strategy vector|keyword|hybrid] [--classification public]
npm run suggest-speakers -- "change streams"
```

- Strategies: `keyword` (BM25 in Node / MongoDB Search text on Atlas), `vector` (cosine), `hybrid`
  (reciprocal rank fusion of both; the default).
- Every search has an explicit classification scope; the default is `public`.
- Nothing relevant means **nothing returned**, never the least-bad hit. Each strategy has its own gate,
  applied before anything is fused:
  - **vector**: two gates, both must pass. Absolute: a hit's cosine must reach `VECTOR_MIN_SCORE`
    (default 0.575, calibrated for `nomic-embed-text`). Scale-free: the top cosine minus the median
    cosine of the retrieved set must reach `VECTOR_MIN_GAP` (default 0.05; not applied below 5
    retrieved chunks). On the sample only the absolute gate separates no-answer queries; the eval
    reports both decisions;
  - **keyword**: a chunk must contain at least `KEYWORD_MIN_COVERAGE` (default 0.5) of the query's
    distinct terms. BM25 scores are not comparable across queries, so the gate is on coverage, not on
    the score;
  - **hybrid**: no threshold of its own. It fuses (reciprocal rank fusion) only the hits that passed
    their own arm's gate. The RRF score is a rank statistic, not a cosine, so `VECTOR_MIN_SCORE` cannot
    apply to it.

  `RetrievalService.explain()` returns each arm's gate statistics alongside the hits.

- `suggest-speakers` only names speakers who exist and who have their own chunk among the retrieved
  evidence; every suggestion cites chunk ids. Retrieved text is fenced as untrusted data, and the model
  call has no tools.

### Stores

| `RETRIEVAL_STORE`      | What                                           | Needs                                         |
| ---------------------- | ---------------------------------------------- | --------------------------------------------- |
| `bruteforce` (default) | chunks in a MongoDB collection, cosine in Node | any mongod                                    |
| `atlas`                | `$vectorSearch` + `$search` indexes            | Atlas or `mongodb/mongodb-atlas-local` (9.0+) |

Which is faster depends on size (`npm run bench:crossover`, synthetic 768-dim vectors): brute force
grows about 0.04 ms per in-scope chunk, Atlas stays at 12 to 30 ms up to 30,000 chunks. **They cross at
about 320 chunks**; past about 1,000, use `atlas`.

Chunks live in one collection per embedder (`chunks__ollama_local_nomic_embed_text`); a document's chunks
that are no longer produced are flagged `retired`, never deleted.

### Running the Atlas arm locally (opt-in)

```bash
npm run atlas:up       # docker run mongodb/mongodb-atlas-local:9.0.4 on :27018, waits for the image's healthcheck
ATLAS_LOCAL_URI='mongodb://127.0.0.1:27018/?directConnection=true' npm run test:atlas
ATLAS_LOCAL_URI='mongodb://127.0.0.1:27018/?directConnection=true' npm run bench:crossover -- --sizes 100,1000,10000
```

`npm test` never needs Docker or Ollama; the Atlas tests are a separate Vitest project and skip unless
`ATLAS_LOCAL_URI` is set and the container reports healthy. Remove the container with
`docker rm -f mug-atlas-local`.

### Retrieval eval

```bash
ATLAS_LOCAL_URI='mongodb://127.0.0.1:27018/?directConnection=true' npm run eval:retrieval
```

Writes `evals/retrieval/report-<date>.md`: every (embedder x store x strategy) arm with recall@k, MRR,
no-answer correctness, forbidden (personal) documents returned, latency and corpus size; plus
`suggestSpeakers` grounding with the real model. Uses the `mug_retrieval_eval` database. The embedder is
a matrix dimension (`EVAL_EMBEDDERS`), one value today.

## Speakers agent (M3b)

**The agent never writes the first message to a speaker. You do, by hand, usually on LinkedIn.** Its job starts once a
conversation exists: it replies, chases and thanks. An `idea` speaker at T-6w becomes a task for you ("Reach out to
<name> about <event>", carrying a suggestion: who, why now, where to reach them), never a draft; you then record what
you wrote with `speakers sent --kind invitation` (which sets them `invited`) or set `invited` yourself. There is no
first-contact approval row: it is structural. No code path can produce a message to a speaker who has no prior sent
message for any event (the types, `decideActions` and the store each refuse it; `speakers-no-first-contact.test.ts`).

**How a message reaches a speaker (delivery).** Read from what we know now, never stored as a preference. A speaker has `emails` (may be empty, lower-cased, unique across speakers) and `handles` (`linkedin`, `whatsapp`,
`other`); a speaker with handles and no email is the normal first state. `decideActions` decides only WHAT is due and
knows nothing about channels. Afterwards `chooseDelivery` reads what we know now: an address -> `email` (a draft, as
always); no address but a handle -> `manual:<handle>`: the SAME drafted text is stored with channel `linkedin` /
`whatsapp` / `other`, plus a task "Send to <name> on <channel>" (closed when you mark the message sent or it is
superseded); nothing at all -> no draft and one task "Find contact details for <name>". The draft cap counts only what
can actually be drafted. Chase rounds and intervals are the same on every channel, so nobody is chased forever.

On manual channels nothing reads replies: record them yourself. `speakers sent <messageId>` (or `speakers sent
--speaker ... --kind ... --on <date>` for something you sent outside the system, stored with the speaker's current
channel) starts the chase clock; `speakers status --set` records what happened. When someone replies by email,
`npm run inbox -- link <messageId> --speaker <id> --event <id> --adopt-address` also records the sender's address on the
speaker, so their next message is an email draft. Without `--adopt-address` nothing about the speaker changes, and the
agent never writes a speaker's identity fields. Seed `handles` in `speakers.seed.json`; addresses are never seeded.
Existing databases: `npm run migrate-speaker-contacts` (once; moves `email` into `emails`).

Runs the speaker pipeline for one event: knows who is at which stage, decides what is overdue, drafts
the messages, and stops for approval where the autonomy table says so. **It sends nothing.** There is no
email channel before M4: drafts land in the `messages` collection, and you copy them out.

**The pipeline is only as current as what you have told it.** Nothing reads an inbox yet, so the agent
cannot know that a message went out or that someone answered. Two commands tell it:

```bash
npm run speakers -- sent <messageId>                                  # you sent it: chases count from now
npm run speakers -- sent --speaker <id> --event <id> --kind invitation --on 2026-11-01
                                                                      # you sent it outside this system
npm run speakers -- status <speakerId> --event <id> --set confirmed   # what happened (guarded)
```

A send you did without a draft here is recorded with `sent --speaker … --kind … --on <date>`: a message
already `sent`, with no text, `sentBy: recorded:<name>`, dated `--on` (chases measure from that date).
Recording the same send again changes nothing (an explicit `--round` makes the natural key the check;
otherwise a recorded send of the same kind on the same day is the same send), and it is refused if a
draft of that kind is still waiting (mark that one instead).

Until a draft is marked sent, nothing is ever chased because of it, and an `invited` speaker whose first message was never recorded is not chased at all. A `sent` repeated after a crash
finishes the status step it missed. Marking an invitation sent moves
the speaker `idea → invited`; marking a thank-you sent moves `slides_received → thanked`.

```bash
npm run speakers -- run --event <id>          # the only command that calls a model
npm run speakers -- list --event <id>         # speaker, status, last sent, next action, then the messages
npm run speakers -- list --event <id> --all   # ... including superseded and rejected drafts
npm run speakers -- show <messageId>          # one draft, readable, to copy out
npm run speakers -- candidates --event <id> --topic "change streams"   # M3's suggestSpeakers
npm run approvals -- list                     # first-contact drafts wait here
```

`run` and `list` take `--now <ISO>` to see the pipeline as of another day. A second `run` the same day
writes nothing and calls no model. A `run` while a first-contact request is still unanswered retires
that request (`expired`) and asks again with the same drafts, so chases for other speakers are not held
up.

### How it decides

The code decides what to do; the model only writes text. `decideActions`
(`src/agents/speakers/decide.ts`) is a pure function of the speakers' statuses, the messages already
in the database, the event date and today. No model, no I/O, no clock of its own. Days are UTC calendar
days relative to the event day:

| Status                | Trigger                                                 | Message                               |
| --------------------- | ------------------------------------------------------- | ------------------------------------- |
| `idea`                | T-6w reached, before the event day                      | a **task** for you, never a message   |
| `invited`             | your first message recorded sent, 7 days since the last | `chase_reply`                         |
| `confirmed`           | T-4w reached                                            | `chase_abstract`                      |
| `confirmed`           | T-3w reached, `speaker.bio` / `speaker.photoUrl` empty  | `chase_bio` / `chase_photo`           |
| `abstract_received`   | T-3w reached, bio / photo empty                         | `chase_bio` / `chase_photo`           |
| `abstract_received`   | T-1w reached                                            | `chase_slides`                        |
| `slides_received`     | the day after the event                                 | `thank_you`                           |
| `declined`, `thanked` | –                                                       | nothing; unsent drafts are superseded |

**A reply pauses everything.** When the inbox has linked a message from a speaker to the event
(`speakers.perEvent[].lastInboundAt`), nothing more is drafted for them, no chase-limit task is raised, and unsent
chases are superseded, until you act: send something (a recorded send counts) or change their status.
It does not depend on triage: a reply the machine could not classify is still a reply. See [Inbox](#inbox-m4a).

A second chase of a kind needs the previous one marked sent and 7 days elapsed. Messages are only
drafted up to T-4d, so every due date can give 3 days' notice and still fall before the event; from
T-3d to the event day an item still missing becomes the "call them" task, and after the event nothing
is chased. A draft rejected at review blocks that kind until a human acts (see below). An unsent draft that no longer
applies (the status moved on, the bio arrived) becomes `superseded`; nothing is deleted.

### Rejecting a draft is not a dead end

Rejection means the same here as in the planner: nothing from the rejected proposal is applied, the
reason and the time of the decision stay on the draft (`rejectionReason`, `rejectedAt`), it is never
edited or deleted, and an explicit human act produces a **new** draft (a new round) with a new approval
request on the same thread. Until you act, the kind is held, and
`list` says how to act. Two ways to act:

- **Reset the speaker's status after the rejection** (`status --set …`): `declined`, then `idea`, then `invited` once you
  have written again. A status change dated later than `rejectedAt` earns a new round.
- **`npm run speakers -- run --event <id> --redraft <kind> --speaker <id>`** for the cases where the
  status cannot be reset (a confirmed speaker's chase). It is a flag on `run`, not a separate command,
  because `run` is the only command that calls a model. It goes through the same table and guards as a
  scheduled message (the kind must apply to the speaker's status today, bio/photo must still be
  missing, the draft window still closes at T-4d) and says why when it is refused.

Rewording a draft is therefore: remove it in `approvals edit` (or reject the request), then `--redraft`.
A stored draft is never edited, so what was reviewed is what exists.

### Chase policy

- `CHASE_MAX_ROUNDS` (2) sent chases of one kind per speaker per event. When the next one would be due,
  the agent writes no message and creates one task instead: "Call <speaker> about the abstract — 2
  chases unanswered".
- `CHASE_MIN_INTERVAL_DAYS` (7) after the last **sent** message.
- `MAX_DRAFTS_PER_RUN` (10): a backlog (a wrong clock, a stale event) is cut, oldest due first; the rest
  come up on the next run.

### Status transitions

`src/agents/speakers/transitions.ts`, one table with a guard. Anything else throws
`IllegalTransitionError`, and a status without a row fails the build.

```
idea              -> invited, declined
invited           -> confirmed, declined, idea      (idea = parked)
confirmed         -> abstract_received, declined
abstract_received -> slides_received, declined
slides_received   -> thanked
declined          -> idea                           (re-approach for a later event)
thanked           -> (terminal)
```

### Facts are never the model's

Dates, times, venue, agenda slot and due dates come from the event record. The model is given
`{{placeholders}}` and what they mean, never the values. Its answer is refused, and retried by the
model ladder, if it writes a date, weekday, time, year, email address, link, amount of money or the
venue itself, or drops a required placeholder. Code then fills the placeholders, and the draft records the
facts it used (`messages.facts`). Due dates give at least 3 days' notice. Retrieved corpus text (the
speaker's own past abstracts and the venue's host notes, public scope) is fenced and declared reference
only, and the drafting call has no tools.

### How a speaker is greeted

Drafts greet the speaker by `preferredName` when a human recorded one on the speaker (it can be set in
`speakers.seed.json`, or on the speaker document), else by the full `name` exactly as stored. **No code
splits or shortens a name**: names do not divide into first and last the same way across cultures, so
there is no "first name" slot. The recipient shown in a review, in `show` and in task titles is always
the full name; `preferredName` only affects the greeting. The agent never writes it (the
forbidden-fields checksum includes it), and a test fails if `src/` ever calls `split` on a name.

### What approval means while nothing sends

`approved` means "send this now"; `draft` means "written, not reviewed" (or not needing review). That is
the whole ceremony. A first-contact draft cannot be marked sent until it is approved. In
`npm run approvals`, `approve` approves every draft in the request, `reject --reason` rejects them all,
and `edit` takes the `show --json` payload with drafts **removed**: the kept ones are approved and the
removed ones rejected. An edit cannot reword a draft or change its recipient.

### What the agent may write

`messages`, `tasks` and `speakers.perEvent[].status`, nothing else. It never creates a speaker, never
changes a speaker's name, email, bio or photo, and never touches an event's date, venue or agenda. A
test compares those fields before and after a run.

### Trajectory evals

```bash
npm run eval:speakers
```

Nine scenarios on a frozen clock with a scripted model (behind the real validation and ladder): never
replies, confirms late, declines, the event moves closer, the clock jumps a month, resume
mid-approval, slides never arrive, four speakers through the whole timeline, and an abstract chase
that only falls due in the closing window. Writes `evals/speakers/report-<date>.md`. They also run in `npm test`.

## Inbox (M4a)

Reads the mail you have chosen to show it, triages each message into a validated summary, links it to a
speaker, organisation and event, and **pauses chasing for a speaker who has written back**. **Nothing in this
milestone, or the next, sends anything:** M4b will create Gmail _drafts_ for you to send yourself. The transport
is **IMAP with an app password**, and the code has no way to write to the mailbox: label folders are opened
read-only (`EXAMINE`), and a test fails on any `APPEND`, `STORE`, `EXPUNGE`, copy, move or flag change anywhere in the source.

### The mailbox is your personal one: what the system may read

The login reaches the whole mailbox (an app password cannot be narrowed by label), so the narrowing is this code's job
and it is the most important thing here. In Gmail's IMAP **every label is a folder**, and the folder is the scope.
**`INBOX` and `[Gmail]/All Mail` (and every other `[Gmail]/...` folder) are never opened**: a label configured as one of
them fails the boot, and the client refuses to open them regardless. Two labels, two levels of trust (both **required**,
no default, and they must differ; an unset or equal pair fails the inbox's boot):

| Label                                      | Applied by                                   | What the system may do                                               |
| ------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------- |
| `GMAIL_LABEL` (e.g. `mug-agents`)          | your `+mug` filter, or you by hand           | fetch the full body, redact it, triage it (a provider call), link it |
| `GMAIL_CANDIDATE_LABEL` (e.g. `mug-maybe`) | loose filters (`from:meetup.com`, a keyword) | **envelope only**: no body is ever fetched and no model is called    |

- **Dismissing** a candidate refuses the _loose_ label for good; applying `mug-agents` to that thread later is a deliberate,
  stronger decision and admits it. To refuse a thread even against that, `exclude-thread` it.
- Scope is the **thread**: once any message in a thread carried `mug-agents` (or you admitted it), its other messages
  _that are in a label folder_ are in scope. **A later reply that carries no label is not reachable** (it lives only in INBOX /
  All Mail, which are never opened): label it, or have a Gmail filter label replies in that thread.
  `exclude-thread` revokes admission, permanently until undone, and beats a fresh label.
- **The cursor is a UID.** Applying a label to a message gives it a **new, highest UID** in that label's folder at that moment
  (checked against the real mailbox: a 2014 message labelled today got the next UID, not one ordered by its date), so "UIDs above the
  last one processed" is exactly "labelled since the last poll", however old the message is. The cursor (last UID per folder,
  stored with `UIDVALIDITY`) is saved after a poll. A changed `UIDVALIDITY` (the folder was deleted and recreated) discards it
  and sweeps the folder again, bounded by `GMAIL_SWEEP_MAX_PAGES`; the unique Gmail id (`X-GM-MSGID`) absorbs what is stored.
  The candidate folder has no cursor: it is small, and re-listing its ids is how `admit` reaches a thread's earlier messages.
- `poll --since <date>` re-reads from the start of the folders (without moving the cursor): use it after `include-thread`,
  because mail that arrived while a thread was excluded was skipped, and an ordinary poll does not go back for it.
- Every message has its **envelope** read (`UID FETCH ... ENVELOPE`, nothing else) before its body is fetched; the body is
  fetched as text parts only (attachments are listed from `BODYSTRUCTURE` and never downloaded); and what comes back is checked
  against the same rule again before it is stored. A message that is neither labelled nor in an admitted thread is dropped.
- **Unverified against a real mailbox** (to be checked on your first dry-run): that `download` returns correctly decoded
  text for Portuguese mail (charsets, quoted-printable); and whether European-Portuguese Gmail writes `No dia ... escreveu:`
  for a quoted reply (it is recognised, but I could not confirm it).
- Raw mail is untrusted data. The full body is stored (`inbound_messages`, `personal`) behind **one** accessor that only
  the inbox module and its CLI may call; the triage call gets the **redacted** body, has no tools, and returns a strict
  schema. Nothing downstream reads a raw body. What leaves the machine is in [docs/data-handling.md](docs/data-handling.md).

### Setting it up

1. In Gmail, create the two labels and the filters that apply them. Make sure IMAP is on (Settings > Forwarding and POP/IMAP).
2. Create an **app password** (Google Account > Security > 2-Step Verification > App passwords; 2-step verification must be
   on). Put it in `.env` as `IMAP_APP_PASSWORD`, with `IMAP_USER` (your address), `GMAIL_LABEL` and `GMAIL_CANDIDATE_LABEL`.
   An app password is a secret: it is never logged and never appears in an error. Revoke it from the same page.
   _Why not OAuth:_ `gmail.readonly` is a restricted scope (a Google security assessment to leave Testing), and a
   refresh token issued while the app is in Testing expires after 7 days.
3. First run, read-only: `npm run inbox -- poll --dry-run` prints what it would store and triage (envelopes only: no body
   fetched, no model called, nothing written). Then `npm run inbox -- poll`.

```bash
npm run inbox -- poll [--since <date>] [--dry-run]
npm run inbox -- candidates                       # loose-label threads: subject, sender, date, thread id
npm run inbox -- admit <threadId>                 # let the system read a candidate (stored, not inferred)
npm run inbox -- dismiss <threadId> [--reason ..] # refuse the loose label for good (undismiss undoes it)
npm run inbox -- exclude-thread <threadId> --reason "..."   # stop reading a thread (include-thread undoes it)
npm run inbox -- list | show <messageId> [--raw]
npm run inbox -- link <messageId> --speaker <id> --event <id>
```

### Triage, linking, and what a reply changes

Triage returns a validated summary (`intent`, `sentiment_decision`, verbatim `mentions`, `materials` cross-checked in
code against the attachments, `asks`, `needs_human`, `confidence`) and **changes nothing in the domain**: it never sets a
status, fills a bio or marks material received. `accepts` becomes a _task_ for you, not `invited → confirmed`.
Linking is deterministic: the sender's address matches a speaker or a contact, or the thread was seen before; a
name match is **not** a link. Anything else waits for `inbox link`.

What a reply does change is **one fact, `lastInboundAt`** (per speaker and event). Any inbound message, classified or
not, **pauses everything for that speaker** in the Speakers agent: no chase, no reach-out task, no chase-limit task, and
unsent chases are superseded, until you act (send something, or change their status). A reply the machine did not
understand is still a reply. `contacts` records the sender as `replied_to_us`: a fact about correspondence, not
permission to write to them (M4b decides that).

### The golden set and the eval

Labelling from scratch does not happen, so the tooling turns it into corrections: `inbox export-golden --out <dir>`
writes anonymised bodies (stable fictional names through a mapping file kept out of git, into a path git ignores) and the
model's proposed labels, **all marked `unverified`**; you correct them and mark each `verified`; `inbox check-golden <dir>`
counts what is left, and **the eval refuses a set that is not fully verified**. The committed fictional sample lives in
`corpus/sample/inbox-golden/`; your real one goes in `corpus/private/inbox-golden/` (git-ignored). A set seeded from one
model anchors on it: every field is verified by a human, and the eval measures _other_ models against it.

```bash
npm run eval:triage -- --models ollama:gpt-oss:20b,ollama:gemma4:31b   # one-rung ladders: escalation disabled
```

The report states the corpus size, the per-class counts and the **majority-class baseline** next to the accuracy
figures. With 10 messages, one case is 10% of a score.

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
