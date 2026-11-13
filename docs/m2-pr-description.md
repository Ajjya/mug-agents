# M2: Checkpointer and human approval

The planner graph can pause for a human decision and resume later, in a different process, with its
state intact; every decision is recorded. It still sends nothing anywhere.

Delivered on `main` in small commits (the project works on `main`, not on a `m2-approval` branch).

## Checkpointer: package and exact API

|              |                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Checkpointer | `@langchain/langgraph-checkpoint-mongodb` **1.5.1** (peer `@langchain/langgraph-checkpoint` 1.2.2) |
| Graph        | `@langchain/langgraph` **1.7.3**, `@langchain/core` 1.3.6                                          |

Read from the installed typings and exercised in a throwaway probe against a real `mongod` before any
code was written (three separate processes):

- `new MongoDBSaver({ client, dbName, checkpointCollectionName, checkpointWritesCollectionName, enableTimestamps })`.
  It takes an **existing `MongoClient`** and creates none. `setup()` (index creation) is not called: the
  same indexes are declared in `src/mongo/indexes.ts` and created by `ensureIndexes()`.
- `graph.compile({ checkpointer })`.
- `interrupt(value, { responseSchema })` inside a node; `responseSchema` is a Zod schema that also
  _validates the resume value_ (used with the decision schema).
- Resume: `graph.invoke(new Command({ resume: decision }), { configurable: { thread_id } })`.
- Continue after a failure: `graph.invoke(null, { configurable: { thread_id } })`.
- Inspect: `graph.getState(config)` gives `next`, `createdAt`, `values` and `tasks[]` with `interrupts[]`
  and `error`. A thread with no checkpoint has `createdAt === undefined`.

## Things that differed from the spec's assumptions

- **The interrupted node does re-run from its start on resume** on the installed version (confirmed:
  a counter incremented before `interrupt()` read 2 after one resume). The spec's assumption holds, so
  `requestPlanApproval` writes its request idempotently before the interrupt.
- **The package depends on `mongodb@6.22`; this project uses 7.8.** A v7 `MongoClient` is not
  assignable to the saver's v6-typed parameter (a structural mismatch on `options`), although it works at
  runtime (verified end to end). One explicit, commented cast in `checkpointer.module.ts` is the only place
  the two driver versions meet.
- **The package's own `ttl` option cannot satisfy "never prune a waiting thread".** It puts a TTL index on
  `upserted_at`, which ages every document from its own creation, so a thread paused for two months would
  lose its latest checkpoint. See Retention.
- **While a node is suspended, its state update is not committed.** The plan shown to the human is
  therefore read from the interrupt value (`tasks[].interrupts[0].value`), not from state.
- **A failed node's error is visible from a fresh process** (`tasks[].error`), so `approvals list` can name
  the failed node and error in a process that never saw the failure.
- **Zod codecs and node update types** (already noted for M1) apply to the new state fields: they use
  `z.custom<...>()`.
- The graph's thread-level API is unchanged from what the spec expected; nothing was written from memory.

## Decisions

- **Thread identity** (`src/graph/thread.ts`): `event:<eventId>:plan`, built only by `threadIdFor`
  and taken apart only by the total `parseThreadId` (`{ ok, value | error }`, never throws). A second
  plan on an event continues the existing thread: waiting means reported as waiting (no model call);
  stopped means continued (only the failed node re-runs); finished with tasks means `already_planned`;
  finished without tasks (rejected) or `--replan` means a new run on the same thread. A second thread for
  one purpose cannot be built.
- **The event is created (or updated) when a new run starts, before the graph runs**, because the thread
  id needs the event id. This is a deviation from M1's "nothing is written until the model work
  succeeded": an event in phase `planning` can exist for a run that failed. It is idempotent (matched by id
  or same day + theme), and the run is resumable. Tasks are still written only after approval.
- **Approval request** carries one extra field beyond the spec, `runId` (one planning run of a thread). A
  unique index on `(threadId, runId, nodeName)` means a re-run node cannot create a second request, even
  under a race. Without it, the re-execution on resume would have no way to tell "my request" from "a new
  request for a re-plan".
- **Interrupt payload** (`PlanReviewPayloadSchema`): event id, theme, the nine milestones (key, label,
  code-computed date, clamped flag, goal, work) and the proposed checklist. No state, prompts or model
  metadata (tested). **Edits** may change goals, work and the checklist, not the event, theme or any
  milestone's key, label or date (`assertEditAllowed`), so a human edit can never smuggle in a date the
  code did not compute. `persistPlan` takes due dates from the code-computed milestones, never from the payload.
- **Decisions** are `approve | edit | reject` with conditional fields enforced in the schema; one decision
  per request (unique index); a decision on a non-pending request is `ApprovalNotPendingError`. Order in
  `decide`: validate, record decision, mark request decided, resume. If the process dies after the mark and
  before the resume, `approvals resume <threadId>` delivers the recorded decision.
- **Orphans** (request written, thread not suspended): `list` marks them, `decide` refuses them
  (`ApprovalOrphanError`), `resume <threadId>` repairs them (the node reuses its request). A pending request
  whose thread has no checkpoint at all is marked `expired` by `resume` (a status, never a removal).
- **Autonomy** (`src/approvals/autonomy.ts`): one frozen table with `satisfies Record<AutonomyAction,
AutonomyLevel>` (adding an action without an entry fails the build) and `requireAutonomy(action)`, which takes
  no other input. `requestPlanApproval` asks the table whether to interrupt; `persistPlan` calls
  `requireAutonomy('create_task')`.
- **Provider failure is resumable.** The service wraps `ProviderUnavailableError`/`StructuredOutputError`
  in `PlanRunInterruptedError(threadId, cause)`; the CLI reports provider and model failures apart and prints
  the resume command. Nothing is persisted by a failed run.
- **Evals** now run the real approval graph on in-memory storage and an in-memory checkpointer.
  `ensure-planned-is-idempotent-for-the-same-brief` plans, approves, plans again and requires
  `already_planned` with no further model calls (the model is a replay of the draft).

## Review fixes (Opus review, before push)

- **Decision reuse compares the whole value.** A decision recorded by a crashed attempt is reused only
  if kind, edited payload and reason are identical; otherwise `ApprovalConflictError`. The graph is
  resumed with exactly the recorded value, so the audit record and the persisted plan cannot differ.
- **`startAt` and `nowIso` are per-run inputs.** `PlannerRuntime.start` always writes them (null when
  absent), so a re-plan on a reused thread no longer inherits the previous run's ladder rung or "today".
- **Calls that start nothing do not write.** `startPlan` looks the event up first; the waiting, stopped
  and already-planned paths leave it untouched. The event is created or updated only when a new run
  starts, and an update keeps earlier `Plan rejected: ...` lines. Rejection reasons are flattened to one
  line, so the step is idempotent for multi-line reasons too.
- **One run per thread across processes.** A lease in the operational `graph_locks` collection
  (`src/graph/thread-lock.ts`): acquire is an upsert on `{ _id: key, expiresAt <= now }`, so a live lease
  makes the insert collide on `_id` (11000 = busy); release expires the lease (no delete). `start`,
  `resume` and `continue` take the thread's lease; `startPlan` also takes a lease on the brief's natural
  key so two concurrent calls cannot both create the event. A busy thread raises `ThreadBusyError`;
  `approvals list` shows it under RUNNING NOW instead of offering it for resume. Lease: 15 minutes, so a
  crashed holder blocks that thread for at most that long.

## Retention: how and why

Completed threads (finished or rejected) are stamped with `expire_at = now + CHECKPOINT_TTL_DAYS` (default 30) on both checkpoint collections; a MongoDB **TTL index on `expire_at`** (`expireAfterSeconds: 0`,
declared in `INDEXES`) removes them. Documents with no `expire_at`, that is every paused or stopped thread,
are invisible to the TTL monitor, so a pending thread cannot be pruned. Starting a new run on a stamped
thread lifts the stamp first. Tested with `ttlMonitorSleepSecs: 1`: a completed thread's documents
disappear; a paused thread whose `upserted_at` is backdated 90 days survives and still resumes.

**The no-delete matcher was not touched and has no exemption.** No delete or prune helper exists in
`src/`: MongoDB removes the documents itself. Choosing a TTL index over a scheduled prune also removed the
need for a scheduler and for any "is this thread still waiting?" query that could be wrong.

## Verification

- `typecheck`, `lint` clean apart from the pre-existing, uncommitted `scripts/graph-demo.ts` (not part of
  this work; it fails two lint rules).
- 22 workflow scenarios run twice: fakes + `MemorySaver` (unit) and MongoDB + the real checkpointer
  (integration): suspend, approve, edit, reject, double decision, invalid edit refused before resume, orphan
  (both kinds), provider failure resumable (only the failed node re-runs, no duplicate tasks), resume twice.
- **Cross-process** (`test/integration/m2-cross-process.test.ts`, `spawnSync` on the built output, a fresh
  OS process per step): interrupt in one process, decide and finish in another; edit and reject likewise; a
  second `plan` from a third process finds the waiting thread; a provider failure in one process is listed
  as resumable by a second and resumed by a third, where only the failed node re-ran and the run identity
  (so the computed milestones) was unchanged.
- One `MongoClient`: asserted that the saver's client is the injected `MONGO_CLIENT`.
- Live against Ollama Cloud, in a scratch `_dev` database: plan paused (`gemma4:31b`, 3.4 s), `list`,
  `show`, reject without reason refused, approve, approve again refused, plan again `already_planned`,
  `--replan`, edit with a changed date refused, edit accepted, a 401 left a resumable thread listed with
  `generateTimeline` and the error, and `resume` continued it. The scratch database was dropped with
  `reset-dev-db`, whose output named the unfinished thread it discarded.

## Not done / notes

- **`.env` still uses `MONGODB_DB=mug_agents`,** which `reset-dev-db` refuses (it must end in `_dev`).
  Rename it to `mug_agents_dev`; `.env.example` says so.
- `MongoDBSaver.deleteThread` exists in the package and is not used.
- No authentication: `decidedBy` is recorded as given (`--by`, `APPROVER_NAME`, or the OS user).
- `docs/data-handling.md` is unchanged: M2 adds no prompt and sends nothing new to a provider.
