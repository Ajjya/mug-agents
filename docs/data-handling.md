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

| Node (milestone)         | Sent to the provider                                                                                                                                                                                                                        | Never sent                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `generateTimeline` (M1)  | Brief theme, format, capacity, co-host **name** (if given), organiser free-text notes (if given, fenced as untrusted data), the nine milestone keys/labels and their code-computed dates, the JSON Schema of the expected answer.           | Event/Task ids, `eventId`, versions, timestamps, speaker or organisation records, any email or phone number the system holds. |
| `generateChecklist` (M1) | The same brief fields and milestone dates, plus the model's own timeline goals (one short sentence per milestone), the allowed owner roles and the JSON Schema.                                                                             | As above.                                                                                                                     |
| `suggestSpeakers` (M3)   | The topic; the speaker **directory** restricted to speakers who have evidence in the retrieved chunks (id, name, topics: no email, no links); the retrieved **public** chunks (text, id, kind, date, speaker id), fenced as untrusted data. | Personal-classified chunks (the search scope is `public`), speaker emails or contact details, any other speaker.              |

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
