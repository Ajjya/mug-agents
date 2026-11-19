# M4a: Inbox (watch, triage, link)

Reads the mail you chose to show the system, triages each message into a validated summary, links it to a
speaker/organisation/event, and pauses chasing for a speaker who has written back. **Nothing sends, nothing drafts in
Gmail** (M4b creates drafts; automated sending is not planned). Delivered on `main` in small commits. Spec:
`specs/M4a-inbox.md` (the file was `M4a-inbox-spec.md`; renamed to the name used in the request).

## 2026-11-19: the transport is now IMAP with an app password (supersedes the Gmail API sections below)

Sections 1 and 4 of the spec changed: Gmail over **IMAP** (`imapflow` 2.12.1) with an app password, not the Gmail API with
OAuth. Everything below that describes `history.list`, OAuth, `inbox auth`, label-id pins and `--repin-labels` is **historical**;
the README and `docs/data-handling.md` describe what is true now. OAuth was rejected because `gmail.readonly` is a restricted
scope (leaving Testing needs a security assessment) and a refresh token issued in Testing lasts 7 days.

**Step 1, verified against the real mailbox (read-only, plus two scratch labels):** applying a label to a message gives it a **new,
highest UID in that label's folder at that moment**, not one ordered by its date. Two 2014 messages applied to an empty scratch folder
in the order 2014-02-26, 2014-03-08 got UIDs 1, 2; applied in the order 2014-03-08, then 2014-02-26 into a second folder they got 1, 2
(the older message got the higher UID). Copying from All Mail with `EXAMINE` worked. `imapflow` exposes `X-GM-MSGID` (`emailId`),
`X-GM-THRID` (`threadId`) and `X-GM-LABELS` (`labels`), and opens read-only with `getMailboxLock(path, { readOnly: true })`.
Observed: `X-GM-LABELS` **leaves out the label of the folder being read**, so the client adds the folder to `labelIds`.
The two scratch labels `mug-uid-probe` and `mug-uid-probe2` are still in your Gmail (each holds copies, nothing was moved or deleted): delete them when you like.

### What the migration had to change outside the transport implementation, and what leaked

The transport implementation is `src/inbox/imap.client.ts` (new), `src/inbox/gmail.errors.ts`, `src/inbox/folders.ts` (new).
Everything else below is a change **outside** it. Per your instruction, none of the leaks is fixed here beyond what the new
transport forced.

| File                                                                                                                                                                                                  | Change                                                                                                                                                                                                                                                                                     | What leaked                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/inbox/gmail.transport.ts` (the interface)                                                                                                                                                        | `MessageRef` gained `folder` and `uid`; `listMessageRefs` takes `afterUid`/`limit` and returns `uidValidity`/`hasMore`; `getMetadata` and `getFull` take a `MessageRef`, not an id; `getThreadRefs`, `getCurrentHistoryId`, `listHistory`, `HistoryExpiredError` are gone; `close()` added | **The interface was shaped by the Gmail API.** Page tokens, history, "list by label id, fetch by message id" and thread listing all assumed an API that can address any message by id from anywhere. IMAP addresses a message by (folder, UID). |
| `src/inbox/inbox.service.ts`                                                                                                                                                                          | `poll()` rewritten: sweep by UID cursor, no history, no id pins, no `processHistory`, no `processAdmittedThreads`; the candidate folder is re-listed from 0 each poll; `--since` re-reads from 0                                                                                           | **An assumption about ordering and about reach.** The service assumed it could re-list the label every poll (no cursor), ask "what else is in this thread?" (`getThreadRefs`) and that label ids were stable. See the behaviour changes below.  |
| `src/domain/inbox.schema.ts`, `src/inbox/repositories.ts`                                                                                                                                             | The cursor is now `folders[{folder, uidValidity, lastUid}]`, not `historyId` / `labelId` / `candidateLabelId`                                                                                                                                                                              | **A field only the API provided:** `historyId` and the Gmail label ids.                                                                                                                                                                         |
| `src/inbox/candidates.ts`                                                                                                                                                                             | `getMetadata(ref)` instead of `getMetadata(id)`; wording                                                                                                                                                                                                                                   | The id-addressing.                                                                                                                                                                                                                              |
| `src/inbox/format.ts`                                                                                                                                                                                 | The "History: ..." line became a "Cursor: ..." line                                                                                                                                                                                                                                        | History was in the report.                                                                                                                                                                                                                      |
| `src/inbox/inbox.config.ts`, `src/config/env.schema.ts`, `src/inbox/inbox.module.ts`                                                                                                                  | OAuth settings, scopes and `INBOX_THREAD_SWEEP_*` removed; `IMAP_*` and `GMAIL_SWEEP_PAGE_SIZE` added; INBOX/`[Gmail]` refused as a label at boot                                                                                                                                          | Credentials and the thread-sweep settings.                                                                                                                                                                                                      |
| `scripts/inbox.ts`                                                                                                                                                                                    | `auth`, `--repin-labels` removed; the client is closed after a poll                                                                                                                                                                                                                        | OAuth flow.                                                                                                                                                                                                                                     |
| **Not changed:** triage (`triage.ts`, `triage.schema.ts`, `redact.ts`, metrics), `linking.ts`, `anonymise.ts`, `golden.ts`, the Speakers agent, every other repository and every other domain schema. |                                                                                                                                                                                                                                                                                            | Nothing leaked there.                                                                                                                                                                                                                           |

**Behaviour that changed, and you should decide on:**

1. **A later reply that carries no label is no longer reachable.** Over the API an admitted thread's unlabelled replies were found by
   listing the thread. Over IMAP they live only in INBOX / All Mail, which are never opened. The thread-level admission still holds
   for messages in a label folder, but "an unlabelled reply in an admitted thread is picked up" (spec 1a) is gone. It needs a Gmail
   filter that labels replies, or you labelling them. A test states this limit.
2. **Label-id pinning is gone.** IMAP has no stable label id. A label renamed or swapped is now caught only as a folder that is missing,
   or as a changed `UIDVALIDITY`, which per your instruction re-sweeps rather than refusing. A `mug-maybe` renamed to `mug-agents`
   would be treated as the admitting folder. Low probability, and it was a review-round guard, so you should know it was removed.
3. **`include-thread` does not go back for mail skipped while a thread was excluded** (the cursor moved past it). Recover with
   `poll --since <date>`. The candidate folder is re-listed each poll, so it is unaffected.
4. **"A configured folder missing from LIST fails at boot"** is enforced at the start of every `poll` (before anything is listed),
   not when the NestJS module boots, so database-only commands do not need a network connection.
5. **ENVELOPE has no `References` header**, so a candidate has none; an admitted message gets it from a separate header fetch.

**Still unverified against a real mailbox:** that `imapflow`'s `download` returns correctly decoded text for real Portuguese mail
(charsets, quoted-printable), and the full `poll --dry-run` path over the real client. I did not run `poll` against your mailbox.
Your stored cursor, if you had run the earlier version, would not parse (it had `historyId`); there was none, since the first real run was yours.

## Settled before coding

Labels `mug-agents` / `mug-maybe`, and triage starting on `gpt-oss:20b`, as given. The fictional sample corpus and the
golden-set tooling were built first, without waiting for the real set. Nothing was built against, or run on, your real
mailbox.

## What the Gmail API actually looked like (spec section 14, verified before the poller)

| Question                          | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Node client                       | **`@googleapis/gmail` 22.1.0** (15 MB; Node ≥ 22; depends on `googleapis-common` 9.3.1 → `google-auth-library` 11.3.4) rather than `googleapis` 190.0.0 (246 MB, every Google API). The Node README never names the per-API package; it exists on the registry and works. ESM imports work (`import { gmail } from '@googleapis/gmail'`); **`GaxiosError` is not exported by `google-auth-library`** (it lives in `gaxios`), which I would have written from memory. | npm registry; scratch install; installed types |
| OAuth for a Desktop app           | System browser + **loopback redirect** (`http://127.0.0.1:<port>`) + **PKCE S256**; client type "Desktop app". The copy-paste out-of-band flow is no longer supported. Checked by building an authorisation URL with the installed library (nothing sent to Google).                                                                                                                                                                                                 | Google OAuth docs; probe                       |
| **Refresh-token lifetime**        | **7 days while the consent screen is in "Testing" status**, and `gmail.readonly` is not exempt. Publishing the app ("In production") avoids it. The docs are silent on whether restricted-scope verification applies to a single-user personal app; I did not guess.                                                                                                                                                                                                 | Google OAuth docs                              |
| Expired `historyId`               | **HTTP 404**; the docs say do a full sync. History is "typically available for at least one week" but "may be valid for only a few hours". The error body is not documented, so detection is on status only (any of `status`, `code`, `response.status`).                                                                                                                                                                                                            | Google sync guide                              |
| **When was a label applied?**     | **Nothing exposes it.** A history record has only an `id` (a sequence number); `labelsAdded` entries carry only `labelIds` and the message; a `Message` has `internalDate` (received), `labelIds` and `historyId`; a `Thread` has none. Confirmed in the docs **and** in the installed type definitions.                                                                                                                                                             | docs; `v1.d.ts`                                |
| `format=metadata` and the snippet | **Not stated** in the docs whether `snippet` comes back. The adapter never reads it, and a test feeds it a snippet and a body and shows neither survives.                                                                                                                                                                                                                                                                                                            | docs (silent); test                            |

**What that decided: the poller's shape.** Section 1.5 asked for "a high-water mark over _labelled-at_". That cannot be
built. The fallback section 14 proposed (a bounded re-sweep) is what shipped, in its simplest form: **re-list the label's
ids every poll**, bounded by `GMAIL_SWEEP_MAX_PAGES` (default 20 pages of 500), and let the unique `gmailId` absorb
the repeats. It needs no date at all, so a message received a month ago and labelled today is caught. Cost: one id-list
call per 500 labelled messages per poll (ids only, no content). `history.list` is an optimisation for later _unlabelled_
replies in admitted threads; an expired cursor falls back to the sweep, which is already bounded. Later replies are also
found by `threads.get` (`minimal`: ids and labels, no content) over admitted threads with recent activity
(`INBOX_THREAD_SWEEP_DAYS`/`_MAX`).

## The section 1 decision, and the numbers behind it

**Two labels, two levels of trust** (decided 2026-11-18; written in `docs/data-handling.md`). `mug-agents` admits a
message (body fetched, redacted, triaged, linked); `mug-maybe` is **metadata only** (a body is unreachable for a candidate:
the candidate path is typed against a client with no body method, and a source scan fails if it ever mentions one). A
thread is the unit of admission. Admission is stored (`admitted_threads`, `candidate_threads`), never inferred from messages.

How "an unlabelled private message never reaches a provider" is tested: every scope test **counts at the boundaries**: which
ids had a body fetched, how many model calls there were, and what text each carried. Scenarios: the query path, a **wrong
query** (the listing ignores the label and returns the whole mailbox), the **history path** (the feed names a private
message; it is dropped without even its headers being read), an expired cursor, a label applied after receipt (also with an
expired cursor), a reply in an admitted thread, a reply in an excluded thread (labelled and unlabelled), candidates, admit,
dismiss, both-labels, a missing Gmail label, `--dry-run`, and logs that carry counts only.

### Triage eval (`npm run eval:triage`, `evals/triage/report-2026-11-18.md`)

The committed fictional sample: **10 messages** (speaker_reply 5, venue_reply 1, sponsor_enquiry 1, newsletter 1, other 1,
attendee_question 1), labels **written by hand** (not seeded by a model), every field verified. Each model ran alone on a one-rung
ladder (escalation disabled), with production's prompt and redaction, on Ollama Cloud (no constrained decoding).
**Majority-class baseline for intent: 50%** (always `speaker_reply`); for sentiment_decision 30%; always answering "no human
needed" scores 80% with 0% recall. **One case is 10% of a score.**

| Model                                    | intent | sentiment | materials | needs_human precision / recall | fabricated spans | validation failures | median / p95  |
| ---------------------------------------- | ------ | --------- | --------- | ------------------------------ | ---------------- | ------------------- | ------------- |
| ollama:gemma4:31b                        | 100%   | 100%      | 100%      | 67% / 100% (1 false alarm)     | 0%               | 0%                  | 0.6 s / 1.1 s |
| **ollama:gpt-oss:20b** (the start model) | 80%    | 70%       | 100%      | 100% / **50%** (1 of 2 missed) | 0%               | 0%                  | 3.4 s / 7.8 s |
| ollama:mistral-large-4                   | 70%    | 70%       | 70%       | 100% / 50%                     | 0%               | 50% of attempts     | 44 s / 1201 s |

What this does and does not say:

- **Every model beats the baselines on intent**, but gpt-oss:20b's 80% against a 50% baseline is two wrong answers out of ten.
- **The model you settled on as the start rung missed one of the two `needs_human` cases** (a silent wrong answer: the direction
  the spec says matters most). gemma4:31b caught both, at the cost of one false alarm. With two positive cases in the set,
  that is one message deciding recall: a signal to look at, not a conclusion. I did not change the start model: it is your
  decision, and it should be re-measured on your real set. `TRIAGE_START_MODEL` is one setting.
- **mistral-large-4 gave no valid answer for 3 of 10 messages** (50% of attempts failed validation) and its p95 latency of
  1201 s is not something I can explain from this data (the provider timeout is 60 s); it is reported as measured. In
  production a failed triage still stores the message, sets `lastInboundAt`, and raises a task: the failure costs a human
  glance, never a chase.
- **No fabricated spans from any model** (0 spans outside the text), so the production refusal-and-retry rule was not exercised here.
- **The numbers do not reproduce exactly between runs.** A reviewer's re-run gave gpt-oss:20b intent 70% where mine gave 80%
  (a one-case difference). Temperature is 0, but the cloud is not deterministic, and with 10 messages one case is 10%.
  Read these as "same order of magnitude", not as two decimal places. A re-run also overwrote the committed report, so
  the runner now writes to the next free name (`report-<date>-2.md`) instead of replacing one.
- **Fictional, hand-labelled, 10 messages.** The real number comes from your set, built with `export-golden`: that will be
  anchored on whichever model seeds it, which is why every field must be verified and other models measured against it.

## Decisions that are mine: please check

1. **The labels are optional in the global env schema, required to _start the inbox_.** Making them required globally would
   break every existing command and test. `InboxModule` resolves them in a provider factory, so unset or equal labels fail
   its boot with the names of what is wrong (integration test and the real CLI, both checked). The module is loaded only by
   the inbox CLI, so nothing else boots it.
2. **Metadata before body, for every label-sourced id** (two calls per new message). Stricter than the spec's "re-check after
   fetch": a message the query should not have returned never has its body fetched at all. The body that does come back is
   checked again before it is stored.
3. **Dismissal refuses the loose label; a later explicit `mug-agents` label admits the thread** (a later, stronger human
   decision). **Confirmed by you on 2026-11-18.** `exclude-thread` is the hard stop and beats a label.
4. **The history feed is filtered on what it reports.** `history.list` is unscoped by nature. A record whose labels and
   thread do not place it in scope is dropped with **no fetch, not even headers**.
5. **Our own sent mail is not inbound.** A message carrying `SENT` or `DRAFT` is skipped (counted), not stored or triaged.
6. **Redaction additions:** email addresses are masked, and the prompt carries attachment **kinds**, never filenames (a
   filename can carry a name). Phone numbers are 9 to 15 digits that are not date-shaped; postal lines have a postcode or a
   street word plus a digit. Heuristics, documented in the file.
7. **A reply pauses everything for that speaker until you act** (send something, recorded sends included, or change their
   status). Unsent chases and invitations are superseded; a thank-you is left alone. A tie in timestamps counts as handled.
   If the speaker is in several active events and the thread does not say which, **all** are paused and the message's event
   stays unlinked: too wide a pause is a nuisance, chasing someone who has written back is the worst failure here.
8. **`lastInboundAt` lives on `speakers.perEvent[]`** (spec 6.3 asked for a per-(speaker, event) fact). It is the only field
   the inbox writes on a speaker, it does not touch `updatedAt` (which dates the _status_), and a byte-identical check
   covers everything else.
9. **Triage raises a task for a human** when something needs a decision (accepts, declines, material, `needs_human`, failed
   triage), idempotent per message. Titles carry only the sender's display name, never model text.
10. **The eval measures fabrication with the lenient schema.** Production refuses a span that is not in the text and
    retries; the eval counts it on the first valid answer, so it shows what the model does on its own.
11. **`inbox auth` is an addition** (the first real run needs a refresh token). It prints the token once to the terminal and
    never logs it.

## Review round (all findings fixed, one commit each)

An independent review found four blocking issues in section 1 territory, plus medium and small ones. Every one has a test
that fails without its fix; each fix was mutation-checked, and where a first mutation silently did not apply (Prettier had
reflowed the line) I redid it against the real text.

**Blocking**

1. **An excluded thread's body still reached the model.** Triage, `retry-triage` and `export-golden` never checked
   exclusion. A message stored while the provider was down stayed pending, you ran `exclude-thread`, and the next poll sent
   its redacted body anyway; `data-handling.md` said otherwise. Exclusion is now checked at the moment of the provider call;
   `retry-triage` refuses an excluded thread (and no longer re-triages everything pending); `export-golden` skips them.
2. **A history record's label claim admitted a thread** before anything checked the message. Reproduced: the thread was
   admitted, the body fetched and stored, and the full body sent to the model. Claims now go through the same verified path
   as the sweep. **4.** The spec 1.3 post-fetch re-check was **circular** (the thread was admitted just before it, so it
   passed trivially) and untested. A thread is now admitted by the label only _after_ the body confirms it, and a test where
   the label is gone by the fetch proves the check has teeth.
3. **A candidate body fetch through the history path was untested.** Testing it properly turned up a real hole: **the
   candidate path trusted its listing**, so a wrong candidate query (or a stale history claim) recorded a private message's
   _subject and sender_ in `candidate_threads`. The earlier wrong-query test never saw it (the strong-label pass happened to mark
   those ids as seen first). The candidate label is now verified in the message's own headers; proved red before fixing.
   Each path to a body now has its own test; the pass-2 drop that one test protected is caught by three.

**Medium**

- **Secrets in thrown errors** (spec 4): a failed token exchange put the refresh token in the error's inspected properties.
  Errors are now rebuilt from scratch (operation, HTTP status, scrubbed message); every client call and the `auth` exchange
  go through it. The test serialises message, stack, `util.inspect` with hidden properties and JSON.
- **Redaction missed quote markers** (each leaks a whole quoted thread): `No dia ... escreveu:`, German `schrieb`, Dutch
  `schreef`, Italian, `-----Mensagem Original-----`, forwarded-message lines, bold `**De:**` and German header blocks.
  Eleven cases red first; a test lists prose that resembles a marker and must not be cut.
- **Reply threading data for M4b**: `References`, `In-Reply-To`, `Reply-To` and `Cc` are now requested and stored.
- **Own sent mail was fetched on every poll** (and discarded): skipped before any body fetch.

**Small**

- Labels are **pinned by Gmail id** (a renamed or recreated label is refused until `--repin-labels`).
- An **expired history cursor widens the admitted-thread sweep** (a late reply in a quiet thread was missed for good).
- The scope guarantee is now **also counted at the real client layer** (a stub of the Gmail API itself under the real
  adapter). Shown to matter: an adapter bug that asks for `format=full` on a metadata call is caught only there.
- **`poll --dry-run` output is under test** (it prints no private subject, sender or address; what was set aside is a count).

**Still unverified against a real mailbox** (stated, not asserted): history snapshot vs current labels, whether a metadata
fetch returns a snippet, how the history 404's body looks, and whether pt-PT Gmail writes `No dia ... escreveu:`. The
first dry-run is where these get checked.

## Tests, and what the mutations said

`npm run verify` is quoted at the end. Mutation checks (break the guard, confirm the right test goes red, restore):

- Scope: letting an unlabelled message reach a body fetch; a body fetch on the candidate path; ignoring exclusion in the
  thread sweep and, separately, in history; history reading headers it cannot place: **all caught**.
- **Two honest non-results.** (a) My first exclusion test applied a label, so _other_ guards caught the message and the
  thread-sweep and history checks survived mutation; I added a test that isolates them (an unlabelled reply in an excluded
  thread) and re-ran: caught. (b) The `dismissed` check inside `recordCandidate` survives mutation because the upstream
  known-thread check already enforces dismissal: redundant defence, not a gap. A first attempt at a fuzzy-name-link mutation
  silently did not apply (Prettier had reflowed the call); I redid it properly: caught.
- Pipeline: triage writing a status; a fuzzy name link; the provider receiving the full body; `lastInboundAt` set only after
  a successful triage; the reply pause (never true, a later send not counting, the limit task not suppressed): **all caught**.
- A downstream module reading `getRawBody` fails the source scan.

Two process slips, both mine, both fixed: I twice committed with `;` instead of `&&` after the linter, so a lint error
went into a commit before a follow-up fixed it (every later command is gated `eslint && tsc && tests && commit`); and a
README I placed in `corpus/sample/inbox-golden/` made the retrieval loader refuse the corpus (8 failures in a full
verify), caught by running the whole suite rather than only my tests.

## The golden set

Tooling first: `export-golden` writes anonymised bodies (stable fictional names through a mapping file kept out of git, 0600,
and only into a path git ignores: a tracked path inside the repo is refused before anything is read) and the model's proposed
labels, **all `unverified`**; it never overwrites an existing file (a human may have corrected it: tested even when the mapping
forgets what was exported). `check-golden` counts what is left, and **`eval:triage` refuses a set that is not fully
verified**. The committed sample is ten fictional messages with **hand-written** labels (`seededBy: hand`): quoted history,
signatures, phones and postal lines kept so the eval runs the real redaction; one injection; one `needs_human`; one with
attachments. **Bias, stated:** a set seeded from one model anchors on it; what limits that is that a human verifies every
field and that other models are measured against it. The real set is yours to build.

## Real-run notes

**Not done, deliberately.** I did not touch your mailbox. The first real run is yours: `npm run inbox -- auth`, then
`npm run inbox -- poll --dry-run` (headers only: no body fetched, no model called, nothing written), then `poll`. What to
report back: what triage got wrong on real mail, what the redaction missed, whether any private mail appeared in
`candidates`, and the dry-run's counts of dropped messages (a large number is the label filter doing its job, or a filter
that is too broad). Before that, set the OAuth consent screen to "In production" or expect the token to die in a week.

## What M4b will need that does not exist yet

- **A broader scope, deliberately:** `gmail.compose` (restricted; the same all-or-nothing mailbox grant, plus the ability to
  _send_, which `drafts.create` does not need but the scope allows). The scope scan will have to change on purpose.
- **Reply context for a draft:** the `threadId` and the `Message-ID` header are stored per message (`rfcMessageId`), and the
  inbox sees only _inbound_ mail, so the latest message in a thread may be one of ours: M4b must read the thread's last
  message ids (the transport has `getThreadRefs`, ids only) and decide what to reply into.
- **A draft cannot quote the sender**: by the section 5 boundary a reply is written from extracted fields and domain facts,
  not the sender's wording. That costs nuance and is the price of the boundary.
- **What `contacts` permission means**: populated here (`replied_to_us`), never enforced. M4b decides who a draft may be
  addressed to; "wrote to us once" is a fact about correspondence, not consent.
- **Status transitions from a reply** (`accepts` → `invited → confirmed`) are deliberately not here: triage raises a task. They
  need an approval path, and a parsed "yes, and here is my abstract" needs two steps (`invited → confirmed → abstract_received`).
- **A staleness rule for approved drafts**: a draft approved before a reply arrived is superseded by the pause; M4b's queue must
  honour the same rule at send time.

## Verification

Run on commit `1da0e02` (the last commit that changes anything but this paragraph), on a clean working tree, 2026-11-18,
network available (not sandboxed): `npm run verify` (typecheck, lint, `npm test`) **exited 0: 67 test files, 1155 tests, all
passing**; `npm run eval:speakers`: **11/11** trajectories. The integration suite needs the pinned `mongod` cached (see the
README); nothing in the suite calls Gmail, Ollama or Docker. `npm run eval:triage` is the one command that calls a real model
and was run on the fictional sample only (above; the numbers move by about a case between runs).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
