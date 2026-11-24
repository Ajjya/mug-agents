The sample corpus in `corpus/sample/` is FICTION, not MUG history: every person, company, event and talk in it is invented.

# Corpus

Material the retrieval layer (M3) searches: past event pages, posts, talk abstracts and notes, as files.

```
corpus/
  sample/                 committed, fictional; makes tests and evals run in a fresh clone
    manifest.json         one entry per file (required)
    speakers.seed.json    exactly the speakers the sample documents reference
    events/ posts/ abstracts/ notes/
  private/                the real corpus and the real speaker seed; git-ignored as a whole
```

Both roots have the same layout; every command takes the root as an argument (`--corpus corpus/private`).

## manifest.json

```json
{
  "documents": [
    {
      "path": "abstracts/x.md",
      "kind": "abstract",
      "classification": "public",
      "date": "2026-03-12",
      "speaker": "zara-quillfeather",
      "sourceUrl": "https://...",
      "eventId": "...",
      "organisationId": "..."
    }
  ]
}
```

- `kind`: `event | post | abstract | note | host_note`.
- `classification`: `public | personal` (mandatory). A `public` search never returns `personal` chunks.
- `speaker`: the speaker's **handle** from `speakers.seed.json`, not a database id, so a manifest works
  against any database. Ingestion resolves it to the speaker's id (read-only) and fails if it is unknown.
- Ingestion fails loudly on a file with no manifest entry or an entry with no file.

## speakers.seed.json

`{ "speakers": [ { "handle", "name", "topics", "links", "perEvent", "handles"? } ] }`. `handles` (`linkedin`, `whatsapp`, `other`) is how to reach someone before they have an email; a speaker with handles and no address is the normal first state. `links` keeps `github`, `website` and, in the FILE only, `linkedin`: **`links.linkedin` is what you write**, and the loader routes it into `handles.linkedin` (in the database a LinkedIn URL has one home: `handles`, which owns everything used to reach someone). `handles` in the file stays accepted but is not required; if an entry carries `handles.linkedin` as well and the two **differ**, loading fails naming the speaker (nothing is silently preferred). To remove the identical duplicates from an existing file, run `npm run clean-speaker-seed -- --corpus corpus/private`: it edits the text, removes only `handles.linkedin` where it equals `links.linkedin`, leaves everything else byte-identical, is a no-op on a second run, and refuses to touch the file if any two values differ. For speakers already in the database run `npm run migrate-speaker-contacts` once. No email addresses in git.
Seeded by `npm run seed-speakers -- --corpus <root>`, idempotent by handle. Seeding fails if the manifest
references a handle the seed does not define.

## organisations.seed.json

`{ "organisations": [ { "name", "kind", "capacity"?, "address"?, "notes"? } ] }`. Seeded by
`npm run seed-organisations -- --corpus <root>`, idempotent by the exact `(name, kind)` pair. No contacts
and no email addresses in git, and no `history` (it needs event ids); add those in the database. Re-seeding
updates only the fields in the file and never touches contacts or history already on the organisation.

## inbox-golden/ (a different dataset, not corpus documents)

`corpus/sample/inbox-golden/` holds ten **fictional** emails with hand-written, verified labels for the inbox triage
eval (`npm run inbox -- check-golden corpus/sample/inbox-golden`, `npm run eval:triage`). They are JSON, not markdown,
so ingestion ignores them, and nothing here is ever indexed. Every name, company and address is invented, the bodies
keep quoted history, signatures, phone numbers and postal lines on purpose (the eval runs the real redaction on them),
and the labels were written by hand, not seeded by a model. Your real set (anonymised mail you have corrected) goes in
`corpus/private/inbox-golden/`, which git ignores. Do not add a `.md` file under `corpus/`: the loader requires every
one to have a manifest entry.
