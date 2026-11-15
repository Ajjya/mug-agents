# M3: Retrieval over MUG's own history (condensed spec)

Condensed summary of the M3 spec as last revised, not the verbatim text. What was built and how it
differs is in `docs/m3-pr-description.md`.

- **Goal:** grounded answers from MUG's own past material; every answer carries its source chunks; a
  speaker suggestion can only name a speaker in the database. Measure keyword vs vector, and a vector
  index vs brute-force cosine, at a few hundred chunks.
- **Out of scope:** the Speakers agent graph, Gmail or any API ingestion, the LangGraph long-term
  `Store`, reranking, Comms/tone-of-voice.
- **Speakers** are seeded by hand from a committed seed file (no emails), idempotently; ingestion writes
  chunks only and never creates or changes domain documents.
- **Embeddings are local only** (Ollama, default `nomic-embed-text`, model in config). No embedding
  vendor, no key, no text leaves the machine to be embedded. Record model and dimension on every chunk
  (dimension read from the response) and refuse a query from a different model or dimension. One
  `Embedder` interface, no routing layer.
- **Two stores behind one interface** (`upsert`, `search`, `stats`): brute-force cosine in Node over a
  MongoDB collection (default suite), and a `$vectorSearch` index on Atlas or `mongodb-atlas-local` 9.0+
  (opt-in), populated from the same embeddings. No `autoEmbed`.
- **Classification is a mandatory search scope**, applied inside the query on both stores; `search` and
  `suggestSpeakers` default to `public`; a public search never returns a personal chunk.
- **The corpus is files** with a manifest (`path`, `kind`, `classification`, `date`, optional ids);
  ingestion fails on unaccounted files or entries; a small anonymised sample corpus is committed, real
  notes are not. Chunk on natural boundaries; window only oversized sections.
- **Retrieved text is untrusted:** fenced as data; the consuming node has no send/publish tools; an
  injection document must not change a suggestion.
- **Query surfaces:** `search(query, { kind, limit, strategy })` and `suggestSpeakers(topic, { limit })`
  with a schema that forces grounding (`speakerId` resolves, non-empty `citations`, a quoting `reason`);
  nothing relevant means an empty list, never the least-bad chunk.
- **Strategies:** keyword, vector, hybrid (reciprocal rank fusion).
- **Eval:** 12–15 hand-written cases (single, multi, paraphrase, exact term, no answer, injection, kind
  filter); report recall@k, MRR, latency, embedding tokens and corpus size per (embedder × store ×
  strategy); the embedder is a config list, so a second one is a config entry plus a class. Assert
  `suggestSpeakers` grounding separately.
- **Tests:** no network, no Ollama and no Docker in `npm test`; the Atlas arm is opt-in, gated on an env
  flag and the container's healthcheck.
