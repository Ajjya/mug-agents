# Platform mail: what it is, and what a future parser would want from it

Role `platform` (`inbox set-role <address> platform`) is an automated sender from a service we use, whose mail
carries operational data about our events. It is not a person and not noise. In code:

- intent `platform_notification`, decided by **lookup, with no model call** (the same cheapness as `noise`), and the
  message is **kept** (stored in full, like any other), not discarded;
- it raises **no task**, **never moves `lastInboundAt`** (so it cannot pause a chase), is **never linked** to a speaker
  automatically, and the sender is not recorded as having "replied to us". `inbox link` by hand still works;
- when a lookup disagrees with a rule (these senders send `List-Unsubscribe` and calendar parts), the lookup wins and the
  disagreement is counted in `ruleConflicts`, as for any role. For platform senders that count is expected, not a problem;
- `inbox poll` prints how many arrived **per sender**, so the volume is visible before anything is built on it.

**Nothing here parses the mail.** Extracting "3 new RSVPs, 47/60" is deterministic parsing of a known template, not
triage, and belongs with the Logistics agent ("RSVPs vs capacity"). This note is what that parser will need.

## What was observed (subjects only)

From the 467 messages stored by the first real run, sender and subject **shapes** only (digits and quoted names
collapsed). No body was read for this note. What each body contains is therefore **not verified here**: it is inferred
from the subject and from what the service is known to send, and the first thing the parser's author should do is
sample real messages (`npm run inbox -- list`, then `show <id> --raw`) and fix this list.

| Sender                                        | Seen | Subject shape                                                                                                                      | What it should carry, to confirm on a sample                                                                                                                                                  |
| --------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info@meetup.com`                             | 196  | `Latest registrations for <group> @ <venue/co-host>` (about 190 of the 196: a digest, repeated per event)                          | the event it is for; new registrations since the last digest; the running total; probably attendee names; the date it was sent (needed to turn digests into a series)                         |
| `info@meetup.com`                             | 4    | `You've scheduled: <event>`, `See you at: <event>`                                                                                 | the event title and date, venue; confirms an event exists on Meetup                                                                                                                           |
| `info@email.meetup.com`                       | 6    | `Just scheduled: <event>`, `Tomorrow you're hosting: <event>`, `REMINDER: <event>`, `(Action required) ...`                        | event title and date; reminders to members: the event's RSVP state may be in the body                                                                                                         |
| `*-announce@email.meetup.com` (one per group) | 2    | `<group>: REMINDER: <event>`, `We're moving! <group>`                                                                              | group announcements sent to members: same event data, plus free text that is **not** operational                                                                                              |
| `noreply@luma-mail.com`                       | 48   | `New registration for <event>` (45 of 48 for one event), `Guest update for <event>`                                                | one message **per registration**: guest name (personal data), registration time, perhaps ticket type and an answer to registration questions; a guest update changes an existing registration |
| `mug-lisbon@calendar.luma-mail.com`           | 12   | `Update for <event>`, `<event> is starting ...`, `Registration confirmed for <event>`                                              | a calendar-style update for an event: new date, time or location (these come with an `.ics` part); starting-soon reminders                                                                    |
| `mongodb@user.luma-mail.com`                  | 1    | `Please join me as a host for <event> - <session title>`                                                                           | a co-host invitation on Luma: **an ask of a person**, not a count                                                                                                                             |
| `notification@slack.com`                      | 35   | `<name> mentioned you in #<channel>`, `New message in group conversation with <names>`, `New messages from <names> in <workspace>` | Slack relays a message **from a person**: the sender (often the community manager), the channel or conversation, and a snippet of the message text                                            |

## What a parser would want, per sender

**Meetup digests (`Latest registrations for ...`)**

- The event (title, ideally Meetup's event id from a link), and the capacity ("RSVPs vs capacity" needs both).
- New RSVPs since the previous digest and the **running total**; waitlist size, if shown.
- The send time. A digest repeated daily is a time series; the same total in two digests is not two events.
- Idempotence: key by (event id, send time), not by message count.

**Luma registrations (`New registration for ...`)**

- One message per guest: the guest's name and email are **personal data**. A counter needs neither: count messages per
  event, and keep the personal fields out of any shared store.
- `Guest update` can cancel or change a registration: a parser that only counts `New registration` over-counts.
- Capacity and "approved vs waitlisted" if shown.

**Luma calendar updates (`mug-lisbon@calendar.luma-mail.com`)**

- A changed date, time or location of one of our own events (attached as `.ics`, which the rules also mark
  `calendar_invite`: with the `platform` role the lookup wins). This is the one place the parser might need to hand a
  _change_ to the Logistics agent rather than a count.

**Slack (`notification@slack.com`)**

- **Not a number, and not for a counter.** Slack relays messages from the community manager (and others): the sender is
  inside the body, not the From header. The useful fields are who wrote it, where (channel or conversation), and the text.
  A parser that classifies _those_ is doing triage again (they can contain a request for us), which is a different
  design from a template parser. Decide that before building on this role.
- Several senders are not equal: a mention in `#mug-leaders` and a group conversation are different kinds of thing.

## Open questions for whoever builds the parser

1. Does one Meetup digest contain the **total** or only the new ones? (decides whether counts can be rebuilt after a missed day)
2. Do Luma registration mails carry capacity, or only the guest? (decides where "capacity" comes from)
3. Are the Meetup `-announce@` group mails operational at all? They look like member-facing announcements; they may deserve
   role `noise` instead of `platform`.
4. Slack: keep as `platform`, or give relayed messages their own handling? Today they are kept and never become a task,
   which means **a request relayed through Slack will not raise one**. Say so before relying on it.
