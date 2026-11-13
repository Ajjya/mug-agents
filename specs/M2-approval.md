# M2: Checkpointer and human approval (condensed spec)

This is a condensed summary of the M2 spec, not the verbatim text. What was built and where it
differed is in `docs/m2-pr-description.md`.

## Goal

The planner graph can pause for a human decision and resume later in a different process with its state
intact, and every decision is recorded. Interruptible and auditable; still sends nothing anywhere.

## Out of scope

Gmail / Meetup / Telegram / LinkedIn and real sending (M4-M5), model tool calling (M4), RAG (M3), the
supervisor graph (M6), a web UI (a CLI is the approval surface).

## Design rules

1. Every node is safely re-runnable (LangGraph re-executes an interrupted node from its start on
   resume): side effects after the interrupt, or idempotent via the M1 natural-key check and
   `updateWithRetry`.
2. The interrupt payload is a typed Zod contract: what the human needs to decide and nothing more.
3. A decision is `approve | edit | reject`, never a boolean. `edit` carries the corrected payload,
   `reject` a reason. All three are persisted.
4. The autonomy policy is enforced in code at the service boundary from a single table; a node cannot
   opt out and the model is never asked.
5. Checkpoint data is operational and must be bounded; keep the no-delete matcher narrow: either the
   prune lives outside `src/` or a narrow commented exemption is added. Do not widen the matcher.
6. Read the installed checkpointer and interrupt API; report package, version and exact API.
7. A provider failure must become resumable: the thread keeps its state at the last completed node,
   `approvals list` shows it with the failed node, and a test kills a run and resumes it in a new process.

## Structure

`src/graph/{checkpointer.module.ts, thread.ts}`, `src/approvals/{approval.schema.ts,
approvals.repository.ts, approvals.service.ts, autonomy.ts}`, `planner.graph.ts` with the approval
interrupt, `scripts/approvals.ts`. `reset-dev-db` output says checkpoint state is dropped.

## Checkpointer

Official MongoDB checkpointer on the existing `MongoClient` (no second client); its collections live in
the same database with a clear prefix; bounded retention via `CHECKPOINT_TTL_DAYS` (default 30) that
can never touch a thread still waiting on approval; its indexes go through `ensureIndexes()`.

## Thread identity

`event:<eventId>:plan`, deterministic, pure and tested; parsing is total (a result or an error, never
a substring slice at a call site). A second plan on an event with a waiting thread continues it; a
second thread for the same purpose must be impossible by construction.

## Approval model

`ApprovalRequest` (`threadId`, `nodeName`, `eventId`, `kind: plan_review`, `payload`, `status:
pending | decided | expired`, `createdAt`, `decidedAt?`) and `ApprovalDecision` (`requestId`,
`decision`, `editedPayload?` required for edit and validated against the payload schema, `reason?`
required for reject, `decidedBy`, `decidedAt`), both in the M0 schema pattern. A decision on a
non-pending request is rejected; an invalid edit never reaches a node; requests are never deleted.

## The graph change

After `generateChecklist`: `requestPlanApproval` (typed payload, persist the request, then `interrupt()`);
on resume `approve` persists the original, `edit` the edited, `reject` terminates and records the reason
on the event (phase stays `planning`); `persistPlan` is the M1 persistence, idempotent. The request is
written before `interrupt()`, so `approvals list` must flag orphans (pending request, thread not
suspended), with a test.

## Autonomy policy

`draft_internal_note: auto`, `create_task: auto`, `plan_review: approve`, `send_external_message:
approve`, `delete_anything: never`; `requireAutonomy(action)` at the service boundary; exhaustiveness
checked at compile time; `never` cannot be bypassed by any flag or config value.

## CLI

`npm run approvals -- list | show <id> | approve <id> | edit <id> --file x.json | reject <id> --reason
"..." | resume <threadId>`; each prints what happened and how a resumed run ended.

## Tests and acceptance

Unit: thread derivation and total parsing, autonomy exhaustiveness and `never`, approval schemas.
Integration with a stub model: suspend, approve, edit, reject, double decision, invalid edit, orphan,
resume idempotency, resume after a provider failure (only the failed node re-runs), and the defining
test: a graph interrupted in one OS process resumes to completion in another. Retention is bounded and
a pending thread is never pruned (backdated timestamp test). One `MongoClient` in the process. README
covers the workflow, the autonomy table, retention and the domain/operational distinction.
