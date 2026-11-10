# Planner evals

Runs 10 fixed briefs against one or more models and writes a markdown matrix report. This is the
**only** thing in the repo that calls a real model; it is not part of `npm test`.

```bash
npm run eval -- --models ollama:gpt-oss:20b,ollama:gemma4:31b,ollama:mistral-large-4
```

Needs `OLLAMA_API_KEY` in `.env` and spends credits. Set `LLM_PRICES` to get a cost column
(prices per 1M tokens are never hard-coded). Use `LOG_LEVEL=warn` for quiet output.

## What it does

- Cases are `evals/cases/*.json`: `{ id, description, expect, daysFromNow, brief }`. Dates are
  relative to today so the cases never go stale; the structure of each case is fixed.
- Each model is evaluated on its **own pinned rung** (a ladder of one): escalation is disabled, so a
  validation failure after the one same-rung correction retry is a failed case, not a reason to
  climb.
- Every request goes through the provider's shared semaphore (`OLLAMA_MAX_CONCURRENCY`), so a
  10 x 3 matrix is ~60 calls with at most 3 in flight. It takes minutes; progress is printed.
- Plans are persisted to **in-memory** repositories (the same contract as MongoDB, see
  `test/support/repository-contract.ts`), so evals never touch your database.

## Deterministic assertions per case

1. Output validates against the schemas.
2. Every required milestone is present and in chronological order.
3. Every checklist item maps to a known milestone and has an owner.
4. Every `dueAt` is on or before the event date (except the `T+3d` follow-up).
5. No duplicate titles within a milestone.
6. Persisting the same plan twice creates no additional tasks.

The past-date case passes only if the brief is rejected **before any model call**.

These check structure and logic, not whether a task is _useful_; read a plan with `npm run plan` for
that.

## Reading the report

- **Provider failures** (outage, auth, a queue that stays full) have their own column and are
  excluded from the pass rate: they say nothing about the model.
- **First-try passes**: cases where every call was valid on its first attempt.
- **Decoding mode**: whether the provider enforced the schema or the schema was only in the prompt.
  Ollama Cloud currently ignores `format`, so all models run prompt-only.
- Latency is per provider call (queueing for a concurrency slot is excluded). A p95 equal to the
  timeout (`LLM_TIMEOUT_MS`) means calls hit the limit.
