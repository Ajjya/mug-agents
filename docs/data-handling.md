# Data handling: what is sent to a model provider

Prompts carry the fields a node needs, not whole records. No attendee or speaker email address,
phone number, id or message body goes into a prompt unless that node's job requires it. **Keep this
file current whenever a node is added or its prompt changes**; a node that needs more must say why
here first.

Provider for every node today: **Ollama Cloud** (`https://ollama.com/v1`). Ollama states that it
processes prompts and responses to answer requests and does not use them for training; see its
privacy policy. Authentication: bearer API key (`OLLAMA_API_KEY`), sent only in the `Authorization`
header, never logged, never in an error message or a thrown error's properties.

Logs record node, model, attempt, token counts, latency and outcome per call. They never contain
the prompt, the raw model output or any credential.

| Node (milestone)         | Sent to the provider                                                                                                                                                                                                                                                                          | Never sent                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `generateTimeline` (M1)  | Brief theme, format, capacity, co-host **name** (if given), organiser free-text notes (if given, fenced as untrusted data), the nine milestone keys/labels and their code-computed dates, the JSON Schema of the expected answer.                                                             | Event/Task ids, `eventId`, versions, timestamps, speaker or organisation records, any email or phone number the system holds.                                                                                |
| `generateChecklist` (M1) | The same brief fields and milestone dates, plus the model's own timeline goals (one short sentence per milestone), the allowed owner roles and the JSON Schema.                                                                                                                               | As above.                                                                                                                                                                                                    |
| `suggestSpeakers` (M3)   | The topic; the speaker **directory** restricted to speakers who have evidence in the retrieved chunks (id, name, topics: no email, no links); the retrieved **public** chunks (text, id, kind, date, speaker id), fenced as untrusted data.                                                   | Personal-classified chunks (the search scope is `public`), speaker emails or contact details, any other speaker.                                                                                             |
| `triage` (M4a)           | The **redacted** body of one email that you labelled `mug-agents` (quoted history, signature, phone numbers, postal lines and email addresses removed; at most `TRIAGE_MAX_CHARS`), fenced as untrusted data, plus the attachments' **kinds** (MIME types) and the JSON Schema of the answer. | The full body, any `mug-maybe` (candidate) thread, any unlabelled mail, subjects, sender and recipient addresses and names, attachment filenames, headers, ids, the speaker, event and organisation records. |

## Inbox triage (M4a): labelled mail leaves the machine

**This is a change from the project document, which assumed a local model for mail.** The machine cannot run a
generation model, so triage goes to Ollama Cloud like everything else generative. The consequence, stated
rather than absorbed: the redacted text of mail you have labelled `mug-agents` is sent to Ollama Cloud. What
limits the exposure is the scope below, not the redaction.

**Decision (2026-11-18): two labels, two levels of trust.** The mailbox is your personal one, and Gmail's OAuth
scopes are all-or-nothing (`gmail.readonly` grants the whole mailbox), so what the system reads is decided by
this code and by a human, never by a pattern:

| Label (config, required, no default, must differ) | Applied by                                   | What the system may do                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GMAIL_LABEL` (`mug-agents`)                      | the `+mug` filter, or you by hand            | fetch the full body, redact it, triage it (a provider call), link it                                                                   |
| `GMAIL_CANDIDATE_LABEL` (`mug-maybe`)             | loose filters (`from:meetup.com`, a keyword) | **headers only** (subject, sender, date): no body is fetched and no model is called. Nothing more happens until you `admit` the thread |

A thread labelled both is admitted. Once any message in a thread carried `mug-agents`, or you admitted it, later
messages in that thread are in scope even if unlabelled; `exclude-thread` revokes that, permanently, until undone.

What this means for the provider:

- **Sent:** one prompt per labelled message: the instructions, the redacted body, the attachment kinds, and the
  schema. Nothing is sent for an unlabelled message, a candidate thread, a dismissed or excluded thread, or the
  mailbox at large. This is asserted in tests that count model calls and compare the recorded request with the stored
  redacted text.
- **Stripped first, deterministically, in code (`src/inbox/redact.ts`):** quoted history (the standard reply
  markers in English, Portuguese, French and Spanish, `-----Original Message-----`, Outlook header blocks, `>`
  lines), the signature after `-- `, phone numbers, postal-address lines and email addresses. The text is then bounded
  to `TRIAGE_MAX_CHARS`, cut from the end with a marker. The redacted text is stored beside the full body, so the
  eval and any dispute can see exactly what the model was given.
- **Not stripped:** the substance. "I can't make it, I'm having surgery that week" is exactly what triage is for, and
  cannot be removed and still classified. Redaction is hygiene, not a guarantee; the guarantee is that you choose
  what the system sees.
- **Where the full body lives:** MongoDB (`inbound_messages`, classification `personal`, never embedded into the
  public corpus), behind one explicit accessor that only the inbox module and its CLI may call (a source scan
  enforces it). Nothing downstream (the Speakers agent, drafting, retrieval) ever reads it: they consume the validated
  summary and domain fields. A reply draft in M4b will therefore be written from extracted fields, not from the
  sender's wording: that is the price of the boundary.
- **What the model can do:** nothing. The call has no tools, its output is validated against a strict schema that
  contains no ids, status values or normalised dates, and the summary changes no domain record (it raises a task for
  a human when something needs a decision). Fabricated `mentions` (spans not in the text) are refused and retried.
- **Gmail access:** read-only (`gmail.readonly`); no send, compose or modify scope is requested anywhere, and a source
  scan fails on any Gmail write call. The refresh token and client secret come from config and are never logged,
  never in an error message or a thrown error's properties.
- **Logs:** counts and flags only. When a message is dropped for lacking the label, nothing about it (no subject, no
  address) is logged.
- **The golden set:** real mail is exported anonymised (stable fictional names through a mapping file that stays out of
  git) and only into a path git ignores. The committed sample is fictional.

## Embeddings (M3): local only, nothing sent to any provider

Every embedding, for every classification, is computed by a **local** Ollama model
(`EMBEDDING_MODEL`, default `nomic-embed-text`, at `OLLAMA_LOCAL_BASE_URL`). No text is sent to any
provider to be embedded, and there is no embedding API key. Ollama Cloud has no embeddings endpoint
anyway (checked 2026-11-15: `/v1/embeddings` and `/api/embeddings` 404, `/api/embed` 401, no embedding
models in `/api/tags`).

Because public and personal content then share one vector space, the policy is enforced at retrieval:
every search states its classification scope explicitly, the store applies it as a filter inside the
query (a pre-filter on `$vectorSearch`, part of the MongoDB filter on the brute-force arm), and
`search`/`suggestSpeakers` default to `public`. A public search cannot return a personal chunk even
when it is the best match (tested on both stores).

## Caveat: free-text notes

The brief's `notes` field is free text written by an organiser and is sent as-is. Do not paste
personal data (attendee lists, contact details) into it. It is the one field in M1 whose content the
system cannot control; it is fenced in the prompt and declared to be data, and the model's output is
validated by strict schemas, but the text itself still leaves the machine.
