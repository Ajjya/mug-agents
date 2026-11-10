# M1: Event planner graph

Given an event brief, produce a validated timeline and checklist, persist them as `Task` documents
linked to an `Event`, and measure it across models. First milestone that calls a model.

Delivered on `main` in small commits (the project works on `main`, not on a `m1-planner` branch).
Everything outside `src/llm`, `src/agents/planner`, `scripts`, `evals` and config is unchanged except
the small, deliberate domain change below.

## Section 3a probe: does Ollama Cloud honour schema-constrained decoding?

**No.** Probe (`scripts/probe-format.mjs`, run 2026-11-10 against the configured account): a request
whose prompt pushes an unconstrained model out of the schema ("write a poem in prose, owner is
Alice") was sent with the schema set, and the answer checked.

| Model         | Native `/api/chat` + `format` | `/v1/chat/completions` + `response_format: json_schema` | Control (no constraint) |
| ------------- | ----------------------------- | ------------------------------------------------------- | ----------------------- |
| `gpt-oss:20b` | HTTP 200, prose, not JSON     | HTTP 200, prose, not JSON                               | prose                   |
| `gemma4:31b`  | HTTP 200, prose, not JSON     | HTTP 200, prose, not JSON                               | prose                   |

The parameter is accepted and silently ignored, which matches Ollama's docs ("Ollama's cloud
currently does not support structured outputs"). Consequences, as the spec prescribes:

- `callStructured` puts the JSON Schema in the prompt; `OllamaProvider.constrainsOutput = false`.
  If a provider ever enforces it, set the flag and the schema travels as `jsonSchema` instead: one
  file changes.
- The retry policy is **load-bearing**, not a safety net. `LLM_MAX_ATTEMPTS` defaults to **4**.
- Output is parsed strictly: a code fence or any prose around the JSON is a validation failure and is
  retried, never repaired in code.
- The eval report states the decoding mode per model and cannot show the latency cost of
  constraining (there is none to measure).
- Re-run the probe when Ollama's docs change.

## Verified before use

- Base URL `https://ollama.com/v1` (OpenAI-compatible) and `Authorization: Bearer $OLLAMA_API_KEY`:
  confirmed against docs.ollama.com and with a live call.
- Models on this account (`GET https://ollama.com/api/tags` with the key, 23 models). Of the spec's
  candidates: `gpt-oss:20b`, `gemma4:31b`, `mistral-large-4`, `nemotron-3-super`,
  `deepseek-v4.1-flash`, `minimax-m3` are reachable. **`nemotron-3-nano:30b` is not available**, and
  `deepseek-v4-pro` exists only as `deepseek-v4-pro:0813`. Also present: `gpt-oss:120b`, `glm-5.3`,
  `kimi-k3`, `nemotron-3-ultra`, others.
- Prices in the eval run below are the spec's figures, **not verified** against the current price
  page; they are passed through `LLM_PRICES`, never hard-coded.

## Decisions

- **LangGraph in.** A `StateGraph` with Zod state (`planner.state.ts`); each node is a thin wrapper
  over a plain function (`normaliseBrief`, `generateTimeline`, `generateChecklist`) tested with a
  stubbed model. `calls` accumulates through a reducer.
- **Dates and ids are code's job.** `timeline.ts` is pure: nine milestones from the event's UTC
  calendar day (DST-proof); milestones already in the past are clamped to today and flagged; a past
  event date is rejected (`PastEventDateError`) before any model call. A task's `dueAt` is its
  milestone date. LLM schemas are strict (`.strict()`), have no id, version, timestamp or date field,
  and reject any extra key, so an invented `id` fails validation. The timeline schema also enforces
  the nine keys once each in order.
- **One mapping function** (`mapping.ts`) turns LLM output into `TaskInput[]`/`EventPatch`.
- **Domain change (the only one): `Task.milestoneKey`** (optional string), plus
  `TasksRepository.findByEventId` and a `tasks.relatedEventId` index. Needed for the idempotency key
  `(relatedEventId, milestoneKey, normalised title)`. Added to the Mongo repo, the in-memory fake
  and the shared contract suite.
- **Idempotency at two levels.** The natural-key check before insert is race-prone (no unique index:
  the normalised title is not a stored field) and, more importantly, cannot catch a model that words
  its checklist differently on the second run. I found this live: re-running the CLI added 26 more
  tasks. So the CLI entry point `ensurePlanned` first looks for an existing event with agent-created
  tasks and then does nothing (no model call, no write) unless `--replan`; with `--replan` only new
  titles are added. Event identity: `brief.eventId` if given, else same UTC day + same theme.
- **Event phase** only moves `idea -> planning`; planning never drags a confirmed/published event back.
- **Nothing half-written:** the event and tasks are written only after both model nodes succeeded.
  A crash mid-insert is healed by re-running with `--replan` (natural key skips what exists).
- **Providers.** `LlmProvider` is the narrow interface; `OllamaProvider` translates status codes into
  vendor-neutral failure kinds (`timeout`, `transport`, `queue_full`, `rejected`, `unavailable`) and
  never puts the response body, the URL or the key into an error. One process-wide `Semaphore` per
  provider enforces `OLLAMA_MAX_CONCURRENCY`.
- **`callStructured` ladder** exactly per spec section 6, including 5a: 401/403/5xx or a queue still
  full after two backoff retries throws `ProviderUnavailableError` without touching the next rung;
  validation failures end in `StructuredOutputError` (issues only, never raw output).
- **Observability:** every attempt logs node, model, attempt, rung, tokens, latency, outcome via
  `AppLogger`, never the prompt or output (tested).
- **Data minimisation:** `docs/data-handling.md`.
- **Evals** use in-memory repositories (same contract as Mongo) so they never touch a database. The
  "re-run creates no extra tasks" assertion re-persists the same draft, because a real model's
  second answer legitimately differs.
- **Default ladder** changed from the spec's example order to `gemma4:31b, gpt-oss:20b,
mistral-large-4` on the strength of the eval below.

## Framework APIs that differed from expectation (installed versions)

`@langchain/langgraph` 1.7.3, `@langchain/core` 1.3.6. I read the installed typings and ran a probe
graph before writing the graph; nothing in LangChain's chat-model or structured-output layer is used
(the Ollama client is a plain `fetch` behind our own interface, as the spec asks).

- Zod channel reducers are not a `.reducer()` method: they are registered with
  `schema.register(registry, { reducer: { fn }, default })` where `registry` comes from the
  `@langchain/langgraph/zod` subpath.
- LangGraph derives a node's allowed _update_ type from each schema's **input** type. Our Zod codecs
  (ObjectId in, string out) therefore made `brief` un-returnable from a node (`string` not assignable
  to `ObjectId`). The state uses `z.custom<EventBrief>()` for `brief` and the brief is validated
  explicitly in `normaliseBrief`. `eventId` in the brief is a plain hex-string schema for the same reason.
- Installed `@langchain/langgraph` was 1.7.3 while `npm view` an hour earlier said 1.7.2.

Other version notes (unchanged from M0): Zod 4 `z.toJSONSchema` is used to put the schema in the
prompt; `z.prettifyError` for eval messages.

## Eval results

Run 2026-11-10, 10 cases x 3 models, each pinned (no escalation), prompt-only, concurrency 3, prices
from the spec (unverified). Full matrix: `evals/report-2026-11-10.md`.

| Model             | Pass  | First-try | Median call | p95 call | Tokens in/out | Est. cost |
| ----------------- | ----- | --------- | ----------- | -------- | ------------- | --------- |
| `gemma4:31b`      | 10/10 | 10        | 2.1 s       | 5.2 s    | 11.7k / 10.3k | $0.0058   |
| `gpt-oss:20b`     | 10/10 | 9         | 7.2 s       | 12.1 s   | 12.4k / 17.6k | $0.0062   |
| `mistral-large-4` | 9/10  | 7         | 28.1 s      | 60.0 s   | 10.0k / 58.1k | $0.1230   |

The one failure is `mistral-large-4` on the co-hosted case: both calls timed out at 60 s (a
provider-level stall is indistinguishable from a slow model at this layer; it is counted as a model
failure here because the timeout is the model's latency). No 401/5xx/429 occurred, so provider failures are 0.

**Which model for which node.** Cost, latency and pass rate, in that order of argument: all three
are cheap in absolute terms, so cost barely discriminates between the first two (about $0.006 for
the whole 10-case run each) and only rules out `mistral-large-4` (about 20x more, because it
emits roughly 5x the tokens). Latency then separates them clearly: `gemma4:31b` answers in about
2 s per call against about 7 s for `gpt-oss:20b`, and `mistral-large-4` regularly reaches the timeout. Pass rate is
equal at the top (100%), with `gemma4:31b` the only one that never needed a correction retry. So
`gemma4:31b` on both nodes, `gpt-oss:20b` as the second rung (a different family fails differently),
`mistral-large-4` only as a last resort. I would not give the checklist node a stronger model than
the timeline node: neither showed a quality gap in the deterministic checks.

**Honest limits.** One run, ten cases, one sample per cell: differences of one case are noise. The
assertions check structure and logic, not usefulness of the tasks; a human should read a few plans
before trusting the ladder. Latencies were measured while 3 requests were in flight against a shared
provider and will move. `LLM_MAX_ATTEMPTS=4` means the third rung is unreachable by default (2 + 2);
set 6 to use it.

## Not done / follow-ups

- Real prices: verify `LLM_PRICES` against the plan before relying on the cost column.
- The CLI wrote test data to the development database (`mug_agents`): two live runs of
  `examples/brief.json` left 44 agent tasks on one event. The project has no delete path by design;
  drop them manually if unwanted.
- M2: with the checkpointer, a provider failure should resume from the failed node.
