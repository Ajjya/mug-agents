# M3b — Speakers agent (spec for Claude Code)

The spec as given, verbatim. What was built, and every rule that differs from it and why, is in
`docs/m3b-pr-description.md`.

Project: **mug-agents**. Milestone: **M3b** (the project doc's M2 deliverable, reordered: it needs M3's retrieval to be useful).
Depends on M0–M3 merged, including the M3 review fixes.

---

## 1. Goal

The first real sub-graph: an agent that **runs the speaker pipeline for an event**. It knows who is at which stage, decides what is overdue, drafts the messages, and stops for approval where the autonomy policy says so.

It sends nothing. There is no email channel until M4, so drafts land in the database and I copy them out.

## 2. Out of scope

Gmail or any sending (M4), tone of voice from past posts (M5), the Venues, Comms and Logistics agents, the supervisor (M6), Telegram (M6), reading replies — nothing parses an inbox yet, so the only way the agent learns that a message went out or was answered is that I tell it (§5.3).

## 3. Design rules

1. **The code decides what to do; the model only writes text.** "Status is `invited`, 7 days have passed, no reply recorded → chase" is deterministic. It lives in a pure function with a fake clock in tests, never in a prompt. The model is called only to produce the wording of a message whose purpose, recipient and facts have already been decided.
2. **Facts are never written by the model.** Dates, times, venue, capacity, the agenda slot — these are commitments under the autonomy policy. They are filled from the event record into the draft, and the model is given them as given text it may not alter. A draft whose date does not match the event record is a bug the tests must catch (§11).
3. **Every draft is idempotent by natural key.** On resume a node re-runs from its start, so drafting must not produce a second copy. Natural key: `(eventId, speakerId, kind, round)`. Same discipline as M1's tasks.
4. **The agent cannot harass anyone.** A hard chase limit per speaker per event (§7). When it is reached the agent stops writing messages and creates a task for me instead. This is a policy in code, not a hint in a prompt.
5. **Retrieved corpus text is untrusted** (M3 §7 rules carry over unchanged): chunks are fenced, declared reference-only, and the drafting call gets no tools.
6. **No new state machine in prose.** Allowed status transitions are a table with a guard, like the autonomy table. An illegal transition throws.
7. **Version rule unchanged:** read installed versions, verify APIs, do not write framework code from memory.

## 4. Domain additions

### 4.1 `messages` — the drafts collection

The project doc's `messages` collection, created here. Same schema pattern as M0 (Input / Doc / Patch, `.strict()`, codecs at the boundary).

Fields: `eventId`, `speakerId`, `kind` (`invitation | chase_abstract | chase_bio | chase_photo | chase_slides | thank_you`), `channel` (`email` only for now), `round` (1-based: which chase attempt this is), `subject`, `body`, `facts` (the fact slots used, so a test can assert they match the event), `status` (`draft | approved | rejected | sent | superseded`), `rejectionReason?`, `approvalRequestId?`, `idempotencyKey`, `sentAt?`, `sentBy?`.

- `idempotencyKey` is derived from the natural key in §3.3 and has a unique index. A second draft for the same key is a no-op, not a duplicate.
- Nothing is deleted. A draft replaced by a newer one becomes `superseded`.

### 4.2 Status transitions

`speakers.perEvent[].status` already exists. Add `src/agents/speakers/transitions.ts` with one exported table of allowed transitions and a guard:

```
idea              -> invited, declined
invited           -> confirmed, declined, idea        // idea = parked, not a regression
confirmed         -> abstract_received, declined
abstract_received -> slides_received, declined
slides_received   -> thanked
declined          -> idea                             // re-approach for a later event
thanked           -> (terminal)
```

Anything not in the table throws `IllegalTransitionError`. Exhaustiveness is checked at compile time: adding a status without transitions fails the build.

### 4.3 What the agent may not write

Ingestion in M3 writes chunks only; this milestone keeps the same split. The Speakers agent **writes** `messages`, `tasks` and `speakers.perEvent[].status`. It never creates a speaker, never edits a speaker's name, email or bio, and never touches an event's date, venue or agenda. Test it the way M3 tested ingestion: count and checksum those fields around a run.

## 5. The graph

`src/agents/speakers/speakers.graph.ts`, a `StateGraph` like the planner's. Thread id `event:<eventId>:speakers` (§6 of the M2 spec: deterministic, one thread per purpose per event).

Nodes:

### 5.1 `loadPipeline` — no model
Reads the event and every speaker with a `perEvent` entry for it. Resolves `now` from state (injectable clock, as the planner does).

### 5.2 `decideActions` — no model, pure, fully unit-tested
Returns a list of `PlannedAction { speakerId, kind, round, reason }` from status, elapsed time and the event's milestone dates. The rules, as a table in code:

| Status | Trigger | Action |
|---|---|---|
| `idea` | event is at T-6w or later | `invitation` |
| `invited` | ≥7 days since the last message, no reply recorded | `chase_abstract` → but see §7 |
| `confirmed` | abstract missing and T-4w reached | `chase_abstract` |
| `confirmed` | bio or photo missing and T-3w reached | `chase_bio` / `chase_photo` |
| `abstract_received` | slides missing and T-2d reached | `chase_slides` |
| `slides_received` | event date has passed (T+1d) | `thank_you` |

Also returns `blocked: BlockedItem[]` for anything at its chase limit, which becomes tasks rather than messages.

**This function is the milestone.** It has no model, no I/O and no clock of its own, so it is exhaustively testable: write a table-driven test with a frozen clock covering every row, every boundary (6 days vs 7), and every status.

### 5.3 How the agent learns anything changed

Nothing reads an inbox, so the agent cannot know a reply arrived. Two inputs, both mine:

- `npm run speakers -- sent <messageId>` — marks a draft `sent`, records `sentAt`, and that timestamp is what §5.2 measures "days since the last message" from. **Until a draft is marked sent, no chase is scheduled for it** — otherwise the agent chases a message that was never sent.
- `npm run speakers -- status <speakerId> --event <id> --set confirmed` — I record what happened, through the §4.2 guard.

State this plainly in the README: between M3b and M4 the pipeline is only as current as what I have told it.

### 5.4 `draftMessages` — the model
For each planned action: retrieve context (M3's `search`, scope `public`, the speaker's own past abstracts and the event's host notes), fence it, and call the model with the fact slots as given values. Output schema: `subject`, `body`, and `usedFacts` echoing the slots. The schema forbids the model from returning a date, time or venue string of its own — facts are substituted by code after the model answers, into named placeholders the model is told to leave intact. Validate that every placeholder survived; a missing one is a validation failure and goes back through the existing ladder.

### 5.5 `requestApproval` — `interrupt()`
Per the autonomy table (§6). The payload is the list of drafts with their recipient, kind and reason — not the graph state.

### 5.6 `persistDrafts`
Upsert by `idempotencyKey`; status `approved` for approved drafts, `draft` for the auto ones; create tasks for `blocked` items. Idempotent on resume.

## 6. Autonomy and what approval means with no sending

Add to the existing table:

```
draft_speaker_message        -> auto
first_contact_message        -> approve      // speaker has no prior sent message for any event
chase_in_existing_thread     -> auto         // prior sent message exists, chase limit not reached
thank_you_message            -> approve      // it carries thanks on MUG's behalf
```

**Be honest about what this buys today.** With no sending channel I read every message when I copy it, so approval is not protecting against an unseen send. What it buys is a **work queue**: `approved` means "send this now", `draft` means "written, not reviewed". That distinction is useful by itself, and M4 can turn on sending by consuming `approved` with no redesign. Do not build any approval ceremony beyond that one status distinction.

## 7. Chase policy

- `CHASE_MAX_ROUNDS` (config, default 2) per `(speakerId, eventId, kind)`.
- `CHASE_MIN_INTERVAL_DAYS` (config, default 7) since the last **sent** message of that kind.
- At the limit: no further message of that kind; create a task `"Call <speaker> about <kind> — 2 chases unanswered"` owned by me, and record `blocked` on the action.
- A global `MAX_DRAFTS_PER_RUN` (default 10) so a misconfigured clock or a stale event cannot generate a pile of drafts.

Every one of these four is a test.

## 8. CLI

```
npm run speakers -- run --event <id>              # run the graph, print planned actions and drafts
npm run speakers -- list --event <id>             # pipeline table: speaker, status, last sent, next action
npm run speakers -- show <messageId>              # the draft, readable
npm run speakers -- sent <messageId>
npm run speakers -- status <speakerId> --event <id> --set <status>
npm run speakers -- candidates --event <id> --topic "..."   # M3's suggestSpeakers, unchanged
```

`run` is the only command that calls a model. Approvals continue through the existing `npm run approvals` CLI — do not build a second approval surface.

## 9. Trajectory evals

The project doc asks for trajectory tests. Build the harness here, with a stub model and a frozen clock, since the question is which path the graph took, not what the text said:

- **Speaker never replies:** chases at the right days, stops at `CHASE_MAX_ROUNDS`, creates the task, writes no third message.
- **Speaker confirms late:** after `status --set confirmed`, the next run drafts no invitation and no chase for that kind.
- **Speaker declines:** no further messages of any kind for that event.
- **Event date moves closer:** actions that were not yet due become due, and none fire twice.
- **Clock jumps forward a month:** a backlog does not produce more than `MAX_DRAFTS_PER_RUN` drafts.
- **Resume mid-approval:** interrupt, resume in a new process, no duplicate drafts (the M2 test pattern).

Report as a table: scenario, expected path, actual path, pass/fail. `npm run eval:speakers`.

## 10. Tests

- **Unit:** `decideActions` table-driven over every row and boundary; the transition guard including every illegal transition; chase limits; fact-slot substitution and the missing-placeholder failure; `idempotencyKey` derivation.
- **Integration on `mongodb-memory-server`:** the whole graph with a stub model — drafts persisted once, a second run produces no duplicates, blocked items become tasks, approval moves `draft` → `approved`.
- **Forbidden writes (§4.3):** speakers' identity fields and the event's date/venue/agenda are byte-identical before and after a run.
- **Injection:** a corpus chunk telling the model to change the recipient or add a commitment does not change the draft's facts or recipient.
- No test calls a real model or a real embedder.

## 11. Acceptance criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm test` clean, no network, no Docker, no Ollama
- [ ] `npm run speakers -- run --event <id>` produces drafts, and a second run produces none
- [ ] Every draft's dates, times and venue match the event record exactly (test, not inspection)
- [ ] A speaker at the chase limit gets a task and no further message
- [ ] An illegal status transition is refused
- [ ] A chase is never scheduled for a draft that was never marked `sent`
- [ ] The agent creates no speaker and alters no speaker identity field or event date/venue/agenda
- [ ] `npm run eval:speakers` passes all six scenarios
- [ ] Approval moves a draft to `approved`; resume across processes creates no duplicates
- [ ] README: the pipeline, the transition table, the chase policy, and the plain statement that the pipeline is only as current as what I have told it

## 12. Deliverable

Branch or main, small commits. PR description: the decision table as implemented (any row that differs from §5.2 and why), what the trajectory harness covers and does not, and one paragraph on which parts of this agent would need rewriting when M4 adds real sending and reply parsing — I want to know the coupling before I build it.

## 13. Before writing code

Ask me, do not guess: the chase intervals and limits if you think the defaults are wrong for a volunteer community, whether `thank_you` really needs approval, and anything ambiguous in §5.2's table — that table is the milestone and I would rather settle it in the spec than in review.
