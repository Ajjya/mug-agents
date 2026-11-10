# M1: Event planner graph (condensed spec)

This is a condensed summary of the M1 spec as last revised, not the verbatim text. What was
actually built and why it differs is in `docs/m1-pr-description.md`.

## Goal

Given an event brief, produce a validated timeline and checklist, persist them as `Task` documents
linked to an `Event`, and make it measurable: the same inputs run against several models and
compared on pass rate, latency and cost. First milestone that calls a model. No external
integrations, no tool calling, no approval flow.

## Out of scope

Gmail / Meetup / Telegram / LinkedIn, RAG, `interrupt()` and approval (M2), the checkpointer (M2),
tool calling (M4), an HTTP API for this feature (a CLI is enough), authentication.

## Design rules

1. The model never computes dates and never invents ids. Milestone dates are derived in code from
   the event date; any id in model output is rejected by the schema.
2. LLM-facing schemas (`src/agents/planner/llm-schemas.ts`) are separate from domain schemas: no
   `_id`, `version`, timestamps; plain enums. One explicit function maps LLM output to domain input.
3. Validation failure is an expected event that drives retry/escalation, not an exception.
   3a. Use schema-constrained decoding only if the provider honours it: probe first. If not honoured,
   the schema goes in the prompt, retries become load-bearing and `LLM_MAX_ATTEMPTS` defaults to 4.
4. Temperature 0 for structured calls; anything computable is computed in code.
5. Every model call is observable (node, model, tokens, latency, attempt, outcome) through
   `AppLogger`, never the raw prompt at info level.
6. Version rule: read installed LangChain/LangGraph versions and docs before writing framework code;
   list every API that differed from expectation.

## Providers and configuration

One provider: Ollama Cloud (`https://ollama.com/v1`, OpenAI-compatible, Bearer `OLLAMA_API_KEY`),
behind a provider interface so a second vendor is an env change. A single provider means one shared
failure domain: provider-level failures must fail loudly and distinctly from validation failures.

- `OLLAMA_BASE_URL` (default `https://ollama.com/v1`)
- `OLLAMA_API_KEY`: required only when a call is attempted, never at boot; never logged
- `OLLAMA_MAX_CONCURRENCY` (default 3): provider limit, shared semaphore
- `LLM_MODEL_LADDER`: ordered `provider:model` list; unknown provider and duplicate rungs rejected;
  a ladder of one means no escalation
- `LLM_PRICES`: JSON map model ref to `{ inputPerMTok, outputPerMTok }`; never hard-coded
- `LLM_TIMEOUT_MS` (default 60000), `LLM_MAX_ATTEMPTS` (default 3; 4 if `format` is not honoured)

Data minimisation: prompts carry only what a node needs; `docs/data-handling.md` lists, per node,
what is sent to which provider and is kept current.

## `callStructured` ladder

1. Attempt on the current rung, temperature 0.
2. On a Zod failure retry the same rung once with the issues appended. Never repair output in code.
3. On a second failure move to the next rung; log every rung change with its reason.
4. Ladder or `LLM_MAX_ATTEMPTS` exhausted: `StructuredOutputError` (node, attempts, last issues; never
   raw output or prompt).
5. Timeouts, transport errors and concurrency rejections count as attempts; a concurrency rejection
   retries on the same rung after a backoff. 5a. Auth failure, 5xx or a queue still full after the
   backoff aborts at once with `ProviderUnavailableError` (no further rung).
6. All provider requests pass through a shared semaphore of `OLLAMA_MAX_CONCURRENCY`.

Every attempt records an `LlmCallRecord`; the service returns them with the result.

## The graph

State: `brief`, `milestones` (computed in code), `timeline`, `checklist`, `calls`. Linear nodes:

1. `normaliseBrief`: no model; validates the brief, computes milestone dates.
2. `generateTimeline`: per milestone, a short goal and expected work. Dates are given facts.
3. `generateChecklist`: concrete tasks per milestone (title, owner role, milestone). The due date is
   the milestone date, assigned in code.

Each node is a thin wrapper over a testable function.

## Brief and timeline

`EventBrief`: `theme`, `date`, `format` (`talks` | `workshop` | `lightning`), `capacity`, optional
`coHost`, `notes`. `timeline.ts` is pure: `T-8w, T-6w, T-4w, T-3w, T-2w, T-1w, T-2d, day-of, T+3d` as
`{ key, label, dateIso }`. Milestones already in the past are clamped to today and flagged; an event
date in the past is rejected.

## Persistence

`planner.service.ts` creates or updates the `Event` (phase `planning`), maps the checklist to
`TaskInput[]` (`source: 'agent'`, `status: 'open'`, `dueAt` = milestone date, `relatedEventId`), and
inserts through the repository. Idempotent on `(eventId, milestoneKey, title)` via a deterministic
natural-key check before insert. Nothing is deleted.

## Evals

Ten briefs in `evals/cases/`: normal 8-week, rushed 3-week, workshop, co-hosted, missing optional
fields, past date (must be rejected), large capacity, noisy notes, lightning night, off-topic theme.
Deterministic assertions: schemas valid; all milestones present and ordered; every item maps to a
milestone and has an owner; every `dueAt` on or before the event date (except `T+3d`); no duplicate
titles per milestone; re-running creates no additional tasks.

`npm run eval -- --models <ref,ref,...>` runs cases x models and writes one report: a row per
(case, model), a summary per model (pass rate, median and p95 latency, tokens, cost from
`LLM_PRICES`), provider failures in their own column, and the decoding mode per model. Each model is
pinned to its own rung (no escalation); runs respect `OLLAMA_MAX_CONCURRENCY`.

## Tests and acceptance

Unit tests with no model: timeline (both edge cases), mapping, state schemas, ladder parser,
`callStructured` against a stub provider (valid; invalid-then-valid; always-invalid; queue-full; 401
and 503; timeout) and the semaphore bound. Integration: the service with a stubbed graph, including
idempotency. No test calls a real provider. `typecheck`, `lint`, `test` clean; the 3a probe result is
recorded; a forced 401/503 aborts without trying another rung; the API key never appears in logs or
errors; README covers keys, ladder, planner and evals.
