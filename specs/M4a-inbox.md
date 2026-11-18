# M4a — Inbox: watch, triage, link (spec for Claude Code)

Project: **mug-agents**. Milestone: **M4a** — the reading half of the project doc's M4.
Depends on M0–M3b merged (through `579abf9`).

**Nothing in this milestone sends anything, and nothing in the next one does either.**

M4b will **create Gmail drafts** — `drafts.create`, in the right thread, with the right recipient, sitting in my Gmail until I press send myself. Automated sending is not planned and is not the next milestone. This is what the project doc meant by "drafts in Gmail", and it means the dangerous half of M4 may never need to exist: the agent prepares, I send.

Keep that in mind while building this one, because it changes what M4a owes M4b: a draft needs the Gmail `threadId` and the `Message-ID` to reply into, so capture both now.

---

## 1. The mailbox is my personal one — this shapes everything

MUG mail arrives at my own Gmail account. There is no separate MUG mailbox, and Gmail's OAuth scopes are all-or-nothing: `gmail.readonly` grants the **whole** mailbox, including my job applications, bank, medical and family mail. Google will not narrow that by label.

**So the narrowing is this code's job, and it is the single most important thing in the milestone.**

1. **Two labels, two levels of trust.** My address is MUG's contact point on purpose, and I cannot move my correspondence to a plus-address — I am registered everywhere with the plain one. So a precise filter cannot cover the inbox, and a loose one ("MUG", "MongoDB") would over-collect: coffee mugs, MongoDB newsletters, conference invitations, DevRel mail that is not MUG business. A loose filter deciding what the system reads would put a regular expression in charge of the one guarantee this milestone exists to provide.

   Hence two labels, and the difference between them is the whole access-control model:

   | Label                                 | Applied by                               | What the system may do                               |
   | ------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
   | `GMAIL_LABEL` (`mug-agents`)          | the `+mug` filter, and me by hand        | fetch the full body, triage it, link it              |
   | `GMAIL_CANDIDATE_LABEL` (`mug-maybe`) | loose content filters, `from:meetup.com` | **metadata only** — never a body, never a model call |
   - For candidate threads the client fetches with Gmail's **metadata format** (headers: subject, from, date) and nothing else. A body must be unreachable for a candidate, not merely unused: the fetch path for candidates has no code path that requests a body, and a test asserts that no body and no model call ever occurs for a thread that is only a candidate.
   - `npm run inbox -- candidates` lists them (subject, sender, date, thread id). `admit <threadId>` promotes the thread to §1a admission; `dismiss <threadId> [--reason]` records it as refused and it is never listed again. Both decisions are stored, never inferred, and dismissal is permanent until I undo it.
   - A thread that is both labelled `mug-agents` and `mug-maybe` is admitted — the stronger label wins.
   - Candidate metadata is **not** `inbound_messages`. Keep it in its own `candidate_threads` collection (`threadId`, `subject`, `from`, `lastSeenAt`, `state`: `pending | admitted | dismissed`) so there is no path by which a candidate's record grows a body field later.

   The code must not care which filter applied either label. What it must assume is that **a human decided** admission, and that the decision can arrive late or never.

1a. **Scope is the thread, not the message.** I label a conversation once; I will not re-label every reply, and whether Gmail propagates a thread's labels to later incoming messages is not something to depend on. So: once any message in a `threadId` has carried the configured label, that thread is **admitted**, and later messages in it are in scope even if they themselves are unlabelled. Store admitted threads explicitly (`admitted_threads`: `threadId`, `admittedAt`, `admittedBy: 'label' | 'human'`) rather than inferring it by querying stored messages — it is an access-control record and should read like one.
Admission is revocable: `npm run inbox -- exclude-thread <threadId> --reason "..."`, after which nothing further from that thread is stored or triaged, and the exclusion is permanent until I undo it. Test both: a later unlabelled reply in an admitted thread **is** picked up; a reply in an excluded thread is **not**. 2. Every fetch is **scoped by that label in the query** (`q`/`labelIds`), never an unscoped `messages.list`. 3. Every message is **re-checked after fetch**: it is stored only if its `labelIds` contains the configured label **or** its `threadId` is an admitted thread (§1a). Anything else is dropped and never stored, even if the API returned it. Belt and braces, because a wrong query is one typo away from my entire mailbox. 4. Both labels are config (`GMAIL_LABEL`, `GMAIL_CANDIDATE_LABEL`), required, with **no default** — an unset label must fail at boot, not quietly mean "everything". They must differ, and that is validated too. 5. **The label arrives after the message does**, because I apply it by hand — often days later, on a thread that has been sitting there. So the history feed cannot be the primary source: a message that was already old when I labelled it may never show up as a change. The poller's primary mechanism is a **sweep by label query** (`messages.list` with the label, bounded by a stored high-water mark over _labelled-at_, not received-at), with `history.list` as an optimisation only. Anything `history.list` returns is still filtered through rules 2 and 3. Test the case explicitly: a message received before the last poll and labelled after it must be picked up. 6. **Test it as the security control it is:** a fixture mailbox containing an unlabelled private message must produce zero stored records and no model call, including through the history path and a backfill. Count model calls in that test — a private message reaching a provider is the failure this milestone must make impossible.

Log counts, never subjects or addresses, when a message is dropped for lacking the label.

## 2. Triage runs on Ollama Cloud

My machine cannot run a generation model, so triage goes to Ollama Cloud like everything else generative. (The local `nomic-embed-text` embedder from M3 is unaffected — it already works here and stays.)

Two consequences to build around:

- **No constrained decoding.** The cloud ignores `format`, as M3 established, so triage uses the existing prompt-plus-validate-plus-retry ladder. Nothing new to invent; reuse `callStructured`.
- **Labelled MUG mail leaves the machine.** That is a real change from the project doc §8, which assumed a local model, and it must be written down rather than absorbed. What limits the exposure is §1: only what I have labelled is ever read, and that is MUG business correspondence, not my private mail.

Because redaction is now the only remaining control, do it properly and deterministically, in code, before the body reaches a prompt:

- **Strip quoted history** — everything below the standard reply markers (`On <date>, <name> wrote:`, `-----Original Message-----`, `>` prefixed blocks). This removes most of the volume and most of the incidental third parties who were never writing to us.
- Strip signature blocks (after `-- `), phone numbers and postal addresses.
- Keep the result's length bounded (`TRIAGE_MAX_CHARS`), truncating from the end with a marker, so one long thread cannot push a prompt to an unexpected size or cost.
- The redacted text is what goes to the provider; the full body stays in the database under §5's rules. Store the redacted text too, so the eval and any later dispute can see exactly what the model was given.

Record all of this in `docs/data-handling.md`: provider, what is sent, what is stripped first, and that the scope is one Gmail label.

Redaction is hygiene, not a guarantee — the sensitive part of a message is often its substance ("I can't make it, I'm having surgery that week"), and that cannot be stripped and still classified. The guarantee is §1: I choose what the system sees.

## 2. Goal

A dedicated MUG mailbox is polled; each new message is stored, triaged into a **validated structured summary**, and linked to a speaker, organisation and event where possible. Replies pause the chase clock. Nothing is drafted, nothing is sent.

## 3. Out of scope

Sending, replying, drafting in Gmail (all M4b). Calendar. Meetup. Parsing attachments' contents — their presence, name, type and size are recorded, nothing is opened. Automatic status transitions from a reply (§7.3). Telegram and the supervisor (M6).

## 4. Gmail access

- My own mailbox, scoped to one label — see §1, which takes precedence over anything convenient here.
- OAuth with a refresh token, **read-only scope** in this milestone: `gmail.readonly`. No send or compose scope is requested anywhere, so an accidental send is not merely forbidden but impossible; M4b widens it deliberately and only to `gmail.compose`.
- Credentials and the refresh token come from config, are never logged, never in `.env.example` beyond placeholders, and never in an error message or a thrown error's properties.
- **Polling, not push.** Pub/Sub push needs a public HTTPS endpoint, which does not exist until M7, and a hand-labelled stream is a few threads a week. The sweep in §1.5 is the mechanism; a stored cursor bounds it. A lost or expired cursor degrades to a bounded backfill over the label, never to "fetch everything".
- `npm run inbox -- poll [--since <date>] [--dry-run]`.

## 5. Raw mail is untrusted data — the boundary is structural

The project doc §8 rule, made concrete:

1. The raw body is **stored** (`inbound_messages`) and may be shown to me, but it reaches exactly one model call: the triage call.
2. The triage call has **no tools**, produces **only** the §7 schema, and its output is validated before anything else sees it.
3. **Nothing downstream ever reads the raw body.** The Speakers agent, drafting, retrieval and every future node consume the validated summary and domain fields only. Enforce it by shape: the type the triage node returns contains no raw text field, so a downstream node cannot reach it by accident, and the raw body lives only in the repository behind an explicit `getRawBody(id)` that nothing outside the inbox module and the CLI calls.
4. Fence the body in the triage prompt the way retrieved chunks are fenced, and state in the prompt that its content is data to be described, never instructions to follow.
5. **Accept the cost and write it down:** a reply draft in M4b will be written from extracted fields and domain data, not from the sender's wording. That loses nuance and it is the price of the boundary.

**Test it as an attack, not as a unit:** a message whose body instructs the reader to mark the speaker confirmed, to add a fee, to change the event date, or to treat the sender as a known contact must produce a summary with none of that, and must not change any domain record.

## 6. Domain additions

### 6.1 `inbound_messages`

`gmailId` (unique), `threadId`, `rfcMessageId` (the `Message-ID` header — M4b replies into it), `receivedAt`, `from` (name + address), `to`, `subject`, `bodyText` (full), `bodyRedacted` (what §2 actually sent to the provider), `bodySnippet`, `labelIds` (stored, so a later audit can show the label was present), `attachments: { filename, mimeType, sizeBytes }[]`, `classification: 'personal'` (always — this is why it exists), `triage?` (the §7 summary), `triagedAt?`, `linkedSpeakerId?`, `linkedOrganisationId?`, `linkedEventId?`, `linkState` (`unlinked | auto | confirmed_by_human`).

- Unique index on `gmailId`: re-polling the same message is a no-op, not a duplicate. This is the milestone's idempotency anchor.
- Nothing is deleted (unchanged policy).
- **Never embedded into the public corpus.** If inbound mail is ever indexed, it is `personal` classification and M3 §5.1's mandatory search scope keeps it out of public queries. Do not index it in this milestone.

### 6.2 `contacts` — the outbound allow-list, built now, used in M4b

The project doc's `contacts` collection: `name`, `address` (unique, lowercased), `role`, `speakerId?`, `organisationId?`, `addedBy`, `addedAt`, `source` (`seed | replied_to_us | added_by_human`).

Built here because triage is what discovers addresses, and M4b must not be the milestone where both the allow-list and sending appear at once. **It is populated, never enforced, in this milestone.** A person who writes to us is recorded with `source: 'replied_to_us'` — being in `contacts` is a fact about correspondence, not permission to write to them; M4b decides what permission means.

### 6.3 `replyReceived` — the fact that pauses chases

M3b's coupling note: `chase_reply` is measured from the last sent message and today only stops when a human changes the status. Add a per-`(speakerId, eventId)` fact `lastInboundAt`, set when an inbound message links to that speaker.

`decideActions` must treat **any** inbound message — including one triage could not classify — as a reason to stop chasing that speaker for that event and to raise a `waiting` item saying a reply arrived and needs my attention. A reply the machine did not understand is still a reply, and chasing someone who has written back is the worst failure this system can produce.

This is a change to `decide.ts`, and it needs its own trajectory scenario (§10).

## 7. Triage

### 7.1 The schema (LLM-facing, separate from domain schemas as always)

- `intent`: `speaker_reply | venue_reply | sponsor_enquiry | attendee_question | newsletter_or_noise | other`
- `sentiment_decision`: `accepts | declines | asks_question | sends_material | unclear`
- `mentions`: `{ dates: string[], people: string[], organisations: string[] }` — **verbatim spans as they appear in the text**, not normalised. Normalising a date is a judgement; the model reports what it saw and code interprets it.
- `materials`: `{ abstract: boolean, bio: boolean, photo: boolean, slides: boolean }` — what the sender says they are providing, cross-checked in code against `attachments`.
- `asks`: short strings, what the sender wants from us.
- `needs_human`: boolean, with `reason` — the model's own "I am not sure".
- `confidence`: `low | medium | high`.

No ids, no status values, no dates in a normalised form: the model never emits anything that could be written straight into a domain record.

### 7.2 Linking

Deterministic, in code, no model:

1. `from.address` matches a speaker's or contact's address → link.
2. Gmail `threadId` matches a thread we have seen → inherit its links.
3. Otherwise `linkState: 'unlinked'`, and it waits for me: `npm run inbox -- link <id> --speaker <id> --event <id>`.

A fuzzy name match is **not** a link. Two people share a name eventually, and a wrong link puts someone's mail on another person's record.

### 7.3 What triage may change

**Nothing in the domain, except `lastInboundAt` and the link fields.** It never sets a speaker's status, never fills a bio, never marks material received. `sentiment_decision: 'accepts'` becomes a `waiting` item and a task for me, not `invited → confirmed`.

M3b kept model decisions away from statuses deliberately; this milestone does not quietly undo that. M4b or later can propose transitions through approval — specify that when it is built, not now.

Test it the way M3b tested forbidden writes: every speaker, event and organisation field byte-identical across a poll and triage run.

## 8. The golden set — built by correcting, not by writing

Labelling 50 emails by hand from scratch is a day of work that will not happen, so build the tooling that turns it into an afternoon of corrections. Three steps, and the first two are yours to build:

1. **`npm run inbox -- export-golden --out <dir>`** — takes the labelled, already-stored messages, runs triage, and writes one file per message containing the anonymised body and the model's proposed §7.1 labels, each field marked `"unverified"`. Anonymisation is deterministic and in code: real names, addresses and organisations are replaced with stable fictional ones through a mapping file I keep out of git, so the same person is the same pseudonym in every message and the set stays internally consistent.
2. **`npm run inbox -- check-golden <dir>`** — validates the files, reports how many fields are still `unverified`, and refuses to let the eval run on a set that is less than fully verified. An unverified label is the model grading itself.
3. **I correct the files.** Changing a wrong label is fast; writing one from nothing is not.

Be honest about the bias this introduces and say it in the PR: a set seeded from one model's output anchors on that model. Two things limit it — every field is verified by me before it counts, and the eval compares _other_ models and configurations against it. State in the report which model seeded the set.

Size: **start at 15 and grow**. A small verified set beats a large half-labelled one, and `check-golden` makes adding more cheap as mail arrives. Say plainly in the eval report how many messages and how many per class — with 15 messages a single case is 7% of the score.

- Real set in `corpus/private/inbox-golden/` (git-ignored); a committed **fictional** sample of 8–10 in `corpus/sample/inbox-golden/`, same rules as M3's corpus: obviously fictional names, plus at least one injection message and one that must come out `needs_human`.
- The committed sample is what CI and anyone cloning the repo runs.
- Build the fictional sample and the tooling first; do not wait on me for the real set.

## 9. Eval

`npm run eval:triage -- --models <ref,...>` over the golden set, matrix by model exactly as M1 and M3 do, with escalation disabled so each model is measured on its own.

Report per model: per-field accuracy (`intent`, `sentiment_decision`, `materials`), precision and recall on `needs_human` (both directions matter: a missed "I am not sure" is a silent wrong answer, a constant one is useless), how often `mentions` contains a span not present in the text (a fabrication check, done by substring search in code), schema-validation failure rate, median and p95 latency, and whether constrained decoding was available.

Report corpus size and the per-class counts next to the accuracy numbers. **State the majority-class baseline for `intent`**: if 60% of the golden set is `speaker_reply`, a model that always answers `speaker_reply` scores 0.60, and any accuracy figure has to be read against that. This is the M3 lesson applied up front rather than in review.

## 10. Trajectory additions

Add to `eval:speakers`:

- **A reply arrives mid-chase:** chases stop, a `waiting` item appears, no further message of any kind, and the status is unchanged.
- **An unclassifiable reply arrives:** same behaviour. The machine's confusion must not translate into another chase.

## 11. Tests

- **Unit:** the triage schema including every rejection case; the `mentions`-not-in-text check; linking rules including the explicit refusal to link on a name match; cursor handling, including an expired `historyId` falling back to a bounded backfill rather than a full fetch; `decide.ts` with `lastInboundAt` set.
- **Integration (`mongodb-memory-server`):** poll → store → triage → link, with a fake Gmail transport and a stub model; a second poll of the same messages creates nothing; forbidden-write check per §7.3.
- **Injection:** the §5 attack cases, asserting both the summary and the untouched domain records.
- **No test touches Gmail, a real model or the network.** The Gmail client sits behind an interface with a fake implementation fed from committed fixture JSON.

## 12. Acceptance criteria

- [ ] `npm run verify` clean (typecheck, lint, tests), run after the final commit
- [ ] **An unlabelled message is never stored and never reaches a provider** — asserted on the query path, the history path and a backfill, with model calls counted (§1.6)
- [ ] **A candidate-only thread never has a body fetched and never reaches a model** (test, with both body fetches and model calls counted)
- [ ] `admit` makes a candidate's bodies readable; `dismiss` keeps the thread out permanently, and neither decision is inferrable from message records
- [ ] An unset `GMAIL_LABEL` or `GMAIL_CANDIDATE_LABEL`, or the two being equal, fails at boot
- [ ] No send or compose scope appears anywhere in code or config
- [ ] The redacted body, not the full body, is what the provider receives (assert on the recorded request)
- [ ] `npm run inbox -- poll --dry-run` prints what it would store and triage, and stores nothing
- [ ] A second poll over the same mailbox state creates no duplicate `inbound_messages`
- [ ] An expired history cursor degrades to a bounded backfill over the label, not a full-mailbox fetch (test)
- [ ] A message received before the last poll but labelled after it is picked up (test)
- [ ] A later, unlabelled reply in an admitted thread is picked up; one in an excluded thread is not (test)
- [ ] No downstream module can reach a raw body: `getRawBody` has exactly the callers named in §5.3 (assert with a source scan, like `no-delete.test.ts`)
- [ ] Injection cases change no domain record and produce a clean summary
- [ ] Triage sets no speaker status and fills no speaker field (byte-identical check)
- [ ] An inbound message linked to a speaker stops chases for that event, including when triage failed to classify it
- [ ] Only the read-only Gmail scope is requested anywhere in the code or config
- [ ] `npm run eval:triage` produces a report with the majority-class baseline stated
- [ ] `docs/data-handling.md` says what is sent to which provider for triage, and the decision from §1 with its date

## 13. Deliverable

Small commits on main. PR description: the §1 decision and the eval numbers behind it; what the Gmail API actually looked like versus expectation, with package and version; the real-run notes (poll the real mailbox read-only and report what triage got wrong on real mail, the way the M3b live run was reported); and a paragraph on what M4b will need that does not exist yet.

## 14. Before writing code

Ask me, do not guess: the exact label name to use; which triage model from the ladder to start with; and anything ambiguous in §7.1's schema — that schema is what every later milestone consumes, and I would rather settle it here than in review.

Verify and report, do not write from memory: the current Gmail API Node client package and OAuth flow for an installed app; what an expired `historyId` actually returns; and — the one that decides the poller's shape — **whether anything in the API exposes when a label was applied**, since §1.5 needs a high-water mark over labelled-at and Gmail orders by received-at. If nothing does, say so and propose the fallback (for example a bounded re-sweep window over recent labelled mail, with the `gmailId` unique index absorbing the repeats), and state its cost.

Do **not** touch my real mailbox until the §1 tests pass against fixtures. The first real run is read-only, `--dry-run`, and I will be watching it.
