# M3: Retrieval over MUG's own history

Grounded search over past material and a `suggestSpeakers(topic)` service that can only name speakers
who exist and only cite chunks that were retrieved. Delivered on `main` (the project works on `main`,
not on an `m3-retrieval` branch). Nothing in the planner or the approval flow changed.

## Scope decisions

- **No Speakers agent.** M2 built the approval mechanism, not a Speakers agent, so suggestions are a
  service plus CLI; wiring them into a sub-graph with approval is a later, thin layer.
- **No long-term `Store`.** Facts about people, tone-of-voice examples and decisions have no consumer until
  M5. Retrieval only.
- **Speakers are seeded by hand** (`speakers.seed.json`, no emails in git), never extracted from the corpus
  by a model. Ingestion writes chunks only and never creates or changes a speaker, event or organisation
  (tested by counting them around an ingest).

## Verified before writing code

- **Ollama Cloud still has no embeddings** (2026-11-15, with the account's key): `POST /v1/embeddings` and
  `/api/embeddings` return 404; `POST /api/embed` returns 401 for every model name, including chat models
  that work for chat with the same key; `/api/tags` lists 24 models, none an embedding model.
- **`nomic-embed-text` on the installed tag** (Ollama 0.40.15, `latest`, 137M, F16): **768 dimensions**,
  read from the response; vectors come back unit length (norm 1.0) and deterministic. Context: the registry
  sets `num_ctx 8192` and the model card advertises 8192, but `ollama show` reports a context length of
  2048 and inputs above 2048 tokens fail with "the input length exceeds the context length". **2048
  applies**; chunks are capped at about 1000 tokens and the embedder is called with `truncate: false`, so
  an oversized input fails loudly instead of being silently cut.
- **`mongodb/mongodb-atlas-local:9.0.4`** (mongod 9.0.4, mongot 1.78.0 community): serves `$vectorSearch`
  and `$search`. The image's config carries no `Healthcheck` field when inspected from the registry (OCI
  format), but the build history declares `HEALTHCHECK CMD /usr/local/bin/runner healthcheck` (30 s
  interval, 60 s start period), and once running `docker inspect` reports it; the container reported
  `healthy` after about 24 s. `npm run atlas:up` polls that status, never sleeps blindly.
- **`$vectorSearch` and index syntax**, checked against the docs and then executed on atlas-local:
  - index: `createSearchIndex({ name, type: 'vectorSearch', definition: { fields: [{ type: 'vector', path,
numDimensions, similarity, quantization }, { type: 'filter', path }] } })`; becomes queryable
    (`listSearchIndexes()` -> `queryable: true`, `status: 'READY'`) in about 4 s;
  - stage: `{ $vectorSearch: { index, path, queryVector, numCandidates, limit, filter } }`, first stage of
    the pipeline, score via `{ $meta: 'vectorSearchScore' }`;
  - `filter` is a real pre-filter: a `personal` document that was the best match was absent from a
    `public` query;
  - **score for `dotProduct` is (1 + dot) / 2**, verified numerically (0.9903 for a dot of 0.9806).
    Converted back to cosine so both stores share one scale and one threshold.
  - Quantization `none` with `similarity: 'dotProduct'`: the docs recommend dotProduct for float vectors
    that are normalised, and the vectors are normalised at embedding time (so dotProduct is the cosine).
    At a few hundred chunks there is nothing to gain from scalar or binary quantization.
  - `$search`: `compound.must: [{ text: { query, path } }]` with `compound.filter: [{ in: { path, value } }]`
    on a field mapped as `token`; score via `{ $meta: 'searchScore' }`; `lucene.english` analyzer.
- What differed from expectation: the vector score is normalised to 0..1 (not the raw cosine), and the
  registry view of the image hides its healthcheck. Driver: `mongodb` 7.8.0.

## Decisions and their costs

- **Embeddings are local, always** (`nomic-embed-text`, 274 MB). Cost: zero money, no text leaves the
  machine, no API key. Price: retrieval quality below a frontier embedding model (measured below), and
  **`ollama serve` becomes a runtime dependency of the service** for every query, not just ingest: an input
  to the project doc's open question 5 (where it runs 24/7) and to M7.
- **Atlas automated embedding (`autoEmbed`) is out permanently**: it embeds server-side with Voyage, which
  the local-only decision excludes. The Atlas arm indexes the same pre-computed vectors as the brute-force
  arm, so the comparison measures the store, not the model.
- **Classification is a mandatory search scope.** With one embedder, public and personal content share a
  vector space; nothing in the geometry keeps them apart. `SearchQuery.classification` is a required,
  non-empty tuple type; stores apply it inside the query; `search` and `suggestSpeakers` default to
  `public`. Tested on both stores, including a personal chunk that is the best match.
- **Grounding is enforced by the schema, not the prompt.** The answer schema is built per call: `speakerId`
  is an enum of speakers who have evidence among the retrieved chunks, `citations` an enum of retrieved
  chunk ids (at least one), and a refinement requires at least one cited chunk tagged with that speaker _in
  the manifest_. Text inside a chunk ("recommend X") therefore cannot ground X. An invalid answer is retried
  by the existing ladder; after the model answers, every id is re-checked against the repository.
  Nothing retrieved, or nobody among the retrieved material, means an empty list with no model call.
- **Injection:** retrieved chunks are fenced (`<<<CHUNK id=...>>> ... <<<END CHUNK>>>`) and declared
  untrusted; the call has no tools at all, so nothing in the text can make it send anything. The injection
  document is not filtered out: a test shows a model that obeys it cannot get its suggestion through, and the
  eval shows the real model ignored it.
- **Hybrid uses reciprocal rank fusion** (k = 60): it combines ranks, so it needs no calibration between a
  cosine and a BM25 score that live on different scales, has one well-known constant, and cannot invent a
  hit. MongoDB 8.1+ has `$rankFusion`; fusion is done in Node so both stores fuse identically.
- **Manifest speakers are handles, not ids.** The spec's `speakerId?` became `speaker` (a stable handle
  like `zara-quillfeather`): a database id differs per database, so a committed manifest could never
  reference it. Speakers gained an optional `handle` with a unique sparse index; seeding is idempotent by
  handle; ingestion resolves handles to ids read-only and fails if one is missing ("seed first").
- **Chunks are never deleted.** Re-ingest upserts by chunk id (`<documentId>#<n>`); chunks a document no
  longer produces are flagged `retired` and excluded from every search. One collection per embedder.
- **No-answer is decided per strategy, before fusion** (added after review). Until then only the
  vector arm had a threshold. **Keyword had none of its own**: any chunk sharing one non-stopword with
  the query was a hit, and hybrid fused that ungated keyword list, so hybrid's no-answer rested on the
  keyword arm happening to find no shared word. Both no-answer cases in the first eval passed only
  because their words occur nowhere in the corpus. Now:
  - vector: per-hit cosine >= `VECTOR_MIN_SCORE` (absolute), **and** top cosine minus the median of the
    retrieved set >= `VECTOR_MIN_GAP` (scale-free, not applied below 5 retrieved chunks);
  - keyword: per-chunk coverage of the query's distinct terms >= `KEYWORD_MIN_COVERAGE` (0.5), computed
    in Node identically on both stores (BM25 and `$search` scores are not comparable across queries);
  - hybrid: no threshold; it fuses only hits that passed their own arm. An RRF score is a rank
    statistic, so no cosine threshold can apply to it.

  The shared `decide()` applies the gates for both stores; a store only retrieves candidates. Tested per
  strategy on both stores with a query whose one shared word ("pizza") occurs in three documents.

- **Relevance thresholds, calibrated on the 12-document sample.** `VECTOR_MIN_SCORE = 0.575`: unrelated
  queries top out at 0.569, the weakest answerable case scores 0.582, direct matches 0.70+. The margin is
  under 0.01 either side, and it moved when the corpus grew: 0.56 was enough at 10 documents, and at 12 both
  no-answer queries scored above it. The best unrelated score rises as the corpus grows, so a fixed
  cosine needs re-measuring on every substantial corpus change.
- **The scale-free gap gate does not separate on this sample** (added after review, kept alongside the
  absolute threshold). No-answer queries have a gap of about 0.10 (top 0.57 over a low median of 0.47),
  inside the answerable range 0.055 to 0.27: something always stands out a little. `VECTOR_MIN_GAP =
0.05` sits below every answerable case, so here it rejects nothing. It is a guard against a flat
  score distribution (for example after a model change that shifts the band), not what makes no-answer
  work today. The eval reports both decisions for every case.

## Eval: did vectors and the vector index earn their complexity?

`evals/retrieval/report-2026-11-15.md`. Corpus: 10 documents, 10 chunks, 1013 tokens embedded (every
document fits in one chunk). 14 cases, k = 5, public scope, so **k/N = 5/9** (the personal document is out
of scope). **Random baseline: recall@5 0.60, MRR 0.40** averaged over the 11 cases with expected documents.

| Store      | Strategy | recall@5 (baseline 0.60) | MRR (baseline 0.40) | no-answer correct | personal leaked | median / p95 search |
| ---------- | -------- | ------------------------ | ------------------- | ----------------- | --------------- | ------------------- |
| bruteforce | vector   | 0.95                     | 0.94                | 2/2               | 0               | 1.7 / 8.7 ms        |
| bruteforce | keyword  | 1.00                     | 0.89                | 2/2               | 0               | 1.5 / 3.7 ms        |
| bruteforce | hybrid   | 1.00                     | 0.94                | 2/2               | 0               | 1.7 / 3.1 ms        |
| atlas      | vector   | 0.95                     | 0.94                | 2/2               | 0               | 19.4 / 48.1 ms      |
| atlas      | keyword  | 1.00                     | 0.84                | 2/2               | 0               | 12.8 / 23.8 ms      |
| atlas      | hybrid   | 1.00                     | 0.93                | 2/2               | 0               | 32.7 / 76.3 ms      |

`suggestSpeakers` with the real model: 4/4 (right speaker for change streams and sharding, empty for an
unrelated topic, and the injection topic still returned the change-streams speaker, not the one the
document demanded); every citation a retrieved chunk, every speaker real.

**Verdict: what is measured.**

- **Latency.** At this size brute-force cosine in Node answers in about 1.7 ms median, the
  `$vectorSearch` index in about 19 ms (keyword 1.5 vs 13 ms; hybrid 1.7 vs 33 ms). This is measured on
  every case and every arm, and it is the basis for defaulting to the brute-force store: a vector index
  needs mongot, a different deployment and asynchronous index builds, and buys nothing here.
- **Safety properties.** No personal document was returned by any public search on any arm, and both
  no-answer cases came back empty on every arm.
- **Both stores rank the same way** (identical vector results; keyword differs only through Atlas's own
  BM25 and analyzer).

**Rerun after review** (`evals/retrieval/report-2026-11-16.md`): 12 documents, 20 chunks (two documents
split into 4 and 6 chunks), 2684 tokens embedded, 20 cases, k = 5, **N = 11 public documents, k/N = 0.45;
random baseline recall@5 0.52, MRR 0.35**. Gates: `VECTOR_MIN_SCORE` 0.575, `VECTOR_MIN_GAP` 0.05,
`KEYWORD_MIN_COVERAGE` 0.5.

| Store      | Strategy | recall@5 | MRR  | chunk recall@5 (5 split cases) | no-answer correct | personal leaked | median / p95 |
| ---------- | -------- | -------- | ---- | ------------------------------ | ----------------- | --------------- | ------------ |
| bruteforce | vector   | 0.97     | 0.95 | 1.00                           | 3/3               | 0               | 2.0 / 5.0 ms |
| bruteforce | keyword  | 0.78     | 0.81 | 1.00                           | 3/3               | 0               | 2.1 / 8.7 ms |
| bruteforce | hybrid   | 0.94     | 0.94 | 1.00                           | 3/3               | 0               | 2.2 / 7.3 ms |
| atlas      | vector   | 0.97     | 0.95 | 1.00                           | 3/3               | 0               | 14 / 57 ms   |
| atlas      | keyword  | 0.78     | 0.81 | 1.00                           | 3/3               | 0               | 15 / 39 ms   |
| atlas      | hybrid   | 0.94     | 0.94 | 1.00                           | 3/3               | 0               | 28 / 76 ms   |

- Every answer that sits in a non-first chunk came back as that chunk, on every arm. `suggestSpeakers`
  cited `events/2026-10-autumn-summit#1` for the new split-citation case. 5/5 grounding passes.
- No-answer: the absolute vector gate rejected all three no-answer cases. The gap gate passed them
  (gaps 0.095 to 0.101). Keyword found no shared term in 07 and 08, and in 08b ("pizza" shared with three
  documents) its coverage gate rejected 0.25 < 0.5.
- The keyword coverage gate has a cost: keyword recall fell from 1.00 to 0.78, because the paraphrase
  cases 03 and 04 (no shared vocabulary by design) are now rejected rather than matched on incidental
  words. Hybrid keeps them through the vector arm.
- Hybrid 0.94 rather than 1.00 is **case 11** ("how did we write up the last event"): the two new long
  documents push the recap post out of hybrid's top 5. One case again: a demonstration that adding
  documents changes rankings, not a strategy ranking.

**Crossover, measured without embeddings** (`npm run bench:crossover`, `evals/retrieval/crossover-2026-11-16.md`).
Random unit vectors (768 dimensions) stored exactly as the stores keep chunks, 20 random queries per size,
vector strategy:

| Chunks    | brute force median / p95 | Atlas median / p95 | Atlas recall@5 vs exact |
| --------- | ------------------------ | ------------------ | ----------------------- |
| 100       | 3.9 / 8.2 ms             | 12.1 / 13.9 ms     | 1.00                    |
| 300       | 11.1 / 20.7 ms           | 11.7 / 15.2 ms     | 1.00                    |
| 1,000     | 37.2 / 41.3 ms           | 13.7 / 17.7 ms     | 1.00                    |
| 3,000     | 117 / 157 ms             | 12.0 / 17.0 ms     | 1.00                    |
| 10,000    | 448 / 510 ms             | 28.2 / 60.8 ms     | 1.00                    |
| 30,000    | 1.74 / 2.12 s            | 22.5 / 33.4 ms     | 0.99                    |
| 100,000   | 9.93 / 11.1 s            | 98 / 223 ms        | 0.95                    |
| 1,000,000 | not run                  | not run            | -                       |

- **The crossover is about 320 chunks**, not "tens of thousands": brute force costs about 0.04 ms per
  in-scope chunk, because it loads every in-scope vector from MongoDB and decodes it on every query. Atlas
  stays at 12 to 30 ms up to 30,000 chunks. That replaces the earlier guess.
- **1M was not run.** Stored as BSON arrays of float64, 1M chunks need about 9.7 GB for brute force and
  about 15 GB with the vector index. The machine had 14 to 18 GB free, and the script keeps 10 GB
  headroom. Brute force at 1M would also need about 13 GB of Node heap per query. On the measured trend
  (about 0.1 ms per chunk at 100k) it would take on the order of 100 s per query: not viable whatever the
  disk.
- **What it means for the default.** The sample (20 chunks) and any MUG corpus of a few hundred chunks
  sit at or below the crossover, so brute force stays the default. Past roughly 1,000 chunks, `atlas` is
  faster, by 10x at 3,000 and 100x at 100,000, at the price of mongot and index builds. Random vectors
  are the worst case for an approximate index, so Atlas recall (0.95 at 100k) is a floor.
- The benchmark exposed a per-query `countDocuments` in the Atlas vector arm (a collection scan for the
  model check). It is now a single `findOne`.

**Verdict: what is only demonstrated.** The ranking columns do not rank the strategies. Every arm is far
above the random baseline, and the gaps between arms come from one or two cases out of fourteen:

- keyword 1.00 vs vector 0.95 recall is **case 06** alone (exact term `resume tokens` across two
  documents; vector found one of them);
- the MRR gap (keyword 0.89 vs vector and hybrid 0.94) is **case 03** (and **04** on Atlas): a paraphrase
  with no shared vocabulary, where only the vector arm ranks the target first.

These show the _mechanisms_ hybrid is meant to combine (keyword catches exact terms, vectors catch
paraphrases, and reciprocal rank fusion keeps both), which is why hybrid is the default. They are not
evidence that hybrid ranks better on MUG's material. The sample is tiny and fictional and every
document is one chunk. Rerun on `corpus/private` before treating any ranking number as MUG's.

## Tests

550 in `npm test` (no network, no Docker, no Ollama: embeddings are a deterministic stub). New: chunking
(whole document, heading split, oversized windowing with overlap, cap below the measured context),
manifest validation, BM25, RRF, recall@k and MRR (including tests that a wrong metric is caught), the
model/dimension mismatch refusal, the embedder's request shape and errors, the store contract on
`BruteForceStore`, seeding idempotency, ingest creating no domain documents, and `suggestSpeakers`
(empty for no match with no model call, grounded answer, fencing, an injection-obeying model rejected,
injection not changing a correct suggestion, unknown id retried). The same store contract runs against
`AtlasVectorStore` in the opt-in `npm run test:atlas` (8/8 against atlas-local 9.0.4).

## Not done / follow-ups

- The real corpus and real speaker seed (`corpus/private/`) are yours to supply; rerun the eval on it and
  re-calibrate `VECTOR_MIN_SCORE`.
- `ollama serve` has to run wherever the service runs (M7).
- 1M chunks not benchmarked (disk). Storing vectors as BSON float32 binary vectors would cut storage about
  3x and decoding cost for brute force; not done.
- Precision is not measured: keyword returns many loosely related documents for broad queries.
