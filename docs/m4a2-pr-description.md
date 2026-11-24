# M4a.2: triage routes by lookup and rules before it asks a model

First real run (467 messages): 56% `newsletter_or_noise`, 33% `other`, nothing linked, and every message went to the provider. `other` was not model error: the taxonomy did not cover this mailbox.

## What changed

1. **Intent enum**: added `cohost_reply`, `coorganiser`, `community_manager`, `calendar_invite`, `document_share`.
2. **Lookup before the model**: `contacts.role` is now an enum (`speaker | venue | cohost | coorganiser | community_manager | sponsor | noise`). A known sender (contact role, else a speaker's email) fixes `intent`; the model is asked only for `sentiment_decision`, materials, asks and `needs_human` (a model that returns `intent` anyway is ignored). Role `noise` needs no model at all.
3. **Rules in code, no model**: `List-Unsubscribe` present -> noise; a `text/calendar` / `application/ics` part -> `calendar_invite`; sender on `INBOX_DOCUMENT_SHARE_SENDERS` (address or `@domain`) -> `document_share`. Precedence: lookup, calendar, sender list, List-Unsubscribe. When two disagree the earlier wins and the disagreement is counted (`ruleConflicts`), never hidden.
4. **Poll output** reports messages decided per method, how many reached a model, conflicts and wall-clock.
5. New commands: `retriage`, `backfill-structure` (headers + BODYSTRUCTURE only, no body), `set-role`, `import-roles`, `validate-rules`.

## Evidence per category (467 stored messages)

| Category                                           | Rests on                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar_invite`                                  | 42 messages carry a calendar part (25 `application/ics`, 17 `text/calendar` attachments). The model had called 30 of them `other`, 7 noise, 4 `venue_reply`.                                               |
| `document_share`                                   | 5 messages from Google's drive-share sender; the model had called 4 `other`, 1 `speaker_reply`.                                                                                                            |
| `cohost_reply`, `coorganiser`, `community_manager` | Not rule-backed. After the enum grew, `other` fell 152 -> 65 and the model chose these for 23 / 22 / 26 messages. **Not human-verified**: they need roles on contacts (the lookup path) to be trustworthy. |

## Rules against the model's own verdicts (the 262 model-noise messages)

- `List-Unsubscribe` caught **28 of 262**. Most noise is not list mail: **196 are `info@meetup.com`** (transactional, no header). A sender rule is safe for 204 of the 262 (senders whose mail was _always_ noise) and would misfire on the other 58 (Slack, monday.com, MongoDB community mail mix real mail with notifications).
- 227 of 262 matched no rule: the model alone knew.
- 68 rule-vs-model disagreements in total, listed one by one (names senders and subjects, so it is git-ignored in `corpus/private/rule-validation.md`). Mostly the model's `other` against a rule's `calendar_invite` / noise (the taxonomy gap). Real conflicts for a human: 4 `venue_reply` vs calendar, and 1 `speaker_reply` each vs sender list, List-Unsubscribe and calendar.
- Neither side was silently preferred.

## Before / after (same 467 messages)

|                          | Before                                                                                                        | After                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reached a model          | 467                                                                                                           | 180 (177 model alone + 3 failed)                                                                                                                              |
| Decided by rule / lookup | 0                                                                                                             | 287 (196 known contact `noise`, 50 List-Unsubscribe, 36 calendar, 5 sender list)                                                                              |
| Wall-clock               | not recorded (stored timestamps span two days with outages); ~78 min estimated at the ~10 s per call seen now | 30 min                                                                                                                                                        |
| Intents                  | noise 262, other 152, speaker 21, venue 17, attendee 7, sponsor 5                                             | noise 257, other 65, calendar_invite 38, community_manager 26, cohost_reply 23, coorganiser 22, document_share 17, speaker 9, venue 5, attendee 2 (+3 failed) |

For the after run, `info@meetup.com` was given role `noise` by hand (196/196 model-noise, never anything else). Speaker/venue counts fell because those messages are now `cohost_reply` / `coorganiser` etc. or `other`; that shift is **not yet verified against labels**.

## Not done / caveats

- No contact except `info@meetup.com` has a role yet, so the lookup path is barely exercised on real data; roles are a human decision (`set-role`, `import-roles`).
- The golden set gained one fictional case per new intent (15 files). The eval scores the model on the full enum, i.e. the unknown-sender path.
- Messages are re-triaged without raising tasks (the first triage did).
