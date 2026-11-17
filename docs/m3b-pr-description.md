# M3b: Speakers agent

An agent that runs the speaker pipeline for one event: it knows who is at which stage, decides what is
overdue, drafts the messages, and stops for approval where the autonomy table says so. It sends
nothing: drafts land in `messages` and are copied out by hand. Delivered on `main` in small commits.

## Settled before coding

Asked and answered, then built as answered:

- An `invited` speaker who has not replied gets its own kind, **`chase_reply`**, instead of the spec's
  `chase_abstract`. Otherwise CHASE_MAX_ROUNDS (counted per kind) would make reply chases use up the
  abstract chases a speaker gets after confirming.
- **"Missing" comes from data that exists.** Abstract missing means status `confirmed`; slides missing
  means `abstract_received`. Bio and photo missing means `speaker.bio` or `speaker.photoUrl` is empty,
  and they are chased in both `confirmed` and `abstract_received`. A human fills them in; the agent
  never writes them.
- **Slides are chased from T-1w**, not T-2d: at T-2d only one message is possible, the day before the talk.
- **`thank_you` is auto**, not approve.

## The decision table as implemented

`decideActions` (`src/agents/speakers/decide.ts`) is pure: statuses, existing messages, event date and
`now` in; actions, blocked items, superseded drafts and "waiting because…" out. Days are UTC calendar
days relative to the event day.

| Status              | Trigger                                             | Action                      | vs §5.2                 |
| ------------------- | --------------------------------------------------- | --------------------------- | ----------------------- |
| `idea`              | T-6w reached, **before the event day**              | `invitation`                | adds the event-day stop |
| `invited`           | invitation **marked sent**, ≥7 days since last sent | **`chase_reply`**           | own kind (settled)      |
| `confirmed`         | T-4w reached                                        | `chase_abstract`            | same                    |
| `confirmed`         | T-3w reached, bio / photo empty                     | `chase_bio` / `chase_photo` | same; source settled    |
| `abstract_received` | T-3w reached, bio / photo empty                     | `chase_bio` / `chase_photo` | **added** (settled)     |
| `abstract_received` | **T-1w** reached                                    | `chase_slides`              | T-2d → T-1w (settled)   |
| `slides_received`   | T+1d                                                | `thank_you`                 | same                    |

Rules beyond the table, which I decided and you should check:

1. **Chases stop on the event day.** No reminder for an abstract on the day of the talk.
2. **The task comes one interval after the last chase**, not the moment the second chase is sent. The
   last chase gets its 7 days to be answered before "call them" appears.
3. **A rejected draft is final for that kind and event.** Rejecting means "not this message", and the
   agent does not try again. To re-approach, change the status.
4. **Unsent drafts that no longer apply become `superseded`.** For example, the speaker declined while a
   chase sat unsent, or the bio arrived while its chase was waiting.
5. **Due dates are code's**: abstract T-3w, bio/photo T-2w, slides T-2d, a reply within the chase
   interval. Each gives **at least 3 days' notice** (`MIN_NOTICE_DAYS`) and is capped at the day before
   the event. This was added after a real run: a chase drafted on T-3w asked for the abstract "by
   today".
6. **Marking sent moves the status**: invitation sent, `idea → invited`; thank-you sent,
   `slides_received → thanked`, both through the guard. A first-contact draft cannot be marked sent
   until it is approved.
7. **An `invited` speaker whose invitation went out by other means is never chased.** The rule is
   literally "never chase what was not marked sent". If you invite someone by hand, mark them `invited`
   and expect no chase.

## Other deviations from the spec

- **Node order.** The spec has `draftMessages → requestApproval → persistDrafts`. Here it is
  `draftMessages → persistDrafts → requestApproval → applyDecision`. Drafts are stored as `draft`
  before the interrupt, so auto drafts never wait behind someone else's first contact, and approval is
  literally `draft → approved` (spec §11).
- **The approval workflow was generalised, not duplicated.** M2's runtime was planner-specific. It is
  now a generic `GraphRuntime` per thread purpose (`plan`, `speakers`), and `ApprovalsService` routes
  each thread to its owner. An approval request carries either a plan or a list of speaker drafts.
  `npm run approvals` is the only approval surface. For speaker drafts, `edit` can only **remove**
  drafts: kept ones are approved, removed ones rejected. Rewording is not possible, so a kept draft's
  facts and recipient are exactly what code produced.
- **Due dates and the facts list**: `messages.facts` holds the slot values used, and a test compares
  them with the event record.
- **Drafting context degrades.** If local Ollama is down, context falls back to keyword search rather than failing the run.

## What a real run showed (Ollama Cloud, fictional data in the `_dev` database)

Three drafts: an invitation, an abstract chase and a bio chase. Each passed validation on the first
call; a second run planned nothing, drafted nothing and made no model call. Two findings, both fixed
and tested:

1. The invitation prompt asked for a talk "close to their past talks". The model wrote that we had
   "been following your previous talks", but none were retrieved: invented familiarity in a
   first-contact email. Each chunk is now marked `speaker="yes|no"`, and with none of the speaker's own,
   the prompt forbids claiming to know their work. The rerun says "given your expertise in schema
   validation", taken from the speaker's recorded topics.
2. The "by today" due date (rule 5 above).

Not fixed: drafts greet with the full name ("Hi Perpetua Quillfeather"). A `first_name` slot would be
small, but the speaker record has no first-name field, and splitting names in code is wrong often enough
across cultures that I left it.

## Trajectory harness

`npm run eval:speakers` (`evals/speakers/report-2026-11-17.md`): **6/6**. It uses a frozen clock and a
scripted model behind the real structured-call validation and ladder, with in-memory storage.

| Scenario            | Path (one step per run)                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| Never replies       | invitation → chase_reply#1 → chase_reply#2 → task → nothing                   |
| Confirms late       | invitation → chase_reply#1 → (confirmed) chase_abstract#1 → nothing           |
| Declines            | invitation → chase_reply#1 (unsent) → (declined) nothing ×3, chase superseded |
| Event moves closer  | nothing → (date moved) chase_abstract#1 → nothing → nothing                   |
| Clock jumps a month | 10 drafts → 3 drafts (13 due, cap 10)                                         |
| Resume mid-approval | invitation → resumed by another runtime: completed, no model call             |

**Covers:** which messages, which round, on which day; tasks at the limit; supersession; the cap; idempotency on rerun and resume.
**Does not cover:**

- **Wording quality**: the model is scripted; the real-run check above is the only look at real text.
- **Ladder exhaustion**: covered by the structured-call unit tests.
- **Retrieval quality**: covered by M3's eval.
- **Real cross-process resume**: covered instead by `test/integration/speakers-cross-process.test.ts`, which uses OS processes and the MongoDB checkpointer, including a crash between writing the request and suspending.

## Tests

`npm test`: 46 files, 782 tests, no network, Docker or Ollama.

- **decideActions:** table-driven over every row, every 6-vs-7-day boundary, every status, the cap, rejection, supersession and a missing event date.
- **Transition guard:** all 49 pairs.
- **Drafting:** facts from the record, every forbidden pattern, placeholder loss, the minimum notice, and a prompt that never contains a fact value.
- **Workflow suite (13 scenarios),** run in memory and on MongoDB with the real checkpointer:
  - no duplicates on a second run;
  - facts equal to the event record;
  - chase limit → one task;
  - never a chase for an unsent draft;
  - forbidden fields byte-identical across run, approve, sent and a second run;
  - injection (a chunk ordering a new recipient, a fee and a new date: refused twice by validation, the stored draft clean);
  - reject, edit, crash-before-suspend, cap.

## When M4 adds sending and reply parsing: the coupling

**What stays:** `decideActions`, the transition table, drafting, the facts discipline and the approval
step need no change. Sending consumes `approved` (and `draft` for auto kinds) and sets `sent`/`sentAt`,
which are exactly the fields a human sets today. Then the chase clock, the first-contact rule and the
status moves on sending all work unchanged.

**What changes:**

- **Who calls `markSent`:** a sender instead of the CLI. It needs its own idempotency against a
  double send: the natural key is there, but "sent" must become a confirmed provider message id, not
  a flag.
- **`setStatus`:** a reply parser has to propose transitions. Proposing is the risky part: a parsed
  "yes" moving `invited → confirmed` is a model decision on a status, which this design so far keeps
  away from models. It should go through approval or a narrow, tested classifier, not straight in.
- **`chase_reply` measured from the last sent message:** must also stop when _any_ reply arrives,
  even an unparseable one. Today "no reply recorded" means "status unchanged". M4 needs a "reply
  received" fact per thread that pauses chases without a status change.

The decide function takes messages as input, so adding received messages to that input is the main
change, not a redesign.

## Not done

- No first-name slot (see above).
- `messages` are never pruned. That is deliberate (nothing is deleted), but superseded and rejected drafts will accumulate.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
