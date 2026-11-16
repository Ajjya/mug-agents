import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MongoClient, type Db } from 'mongodb';
import { z } from 'zod';
import { loadConfig } from '../../src/config/config.module.js';
import { type AppConfig, ConfigError, formatEmbedderRef } from '../../src/config/env.schema.js';
import { buildProviders, buildStructuredCall } from '../../src/llm/llm.module.js';
import { AppLogger } from '../../src/logging/logger.module.js';
import { INDEXES } from '../../src/mongo/indexes.js';
import { MongoSpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { AtlasVectorStore } from '../../src/retrieval/atlas-vector.store.js';
import { BruteForceStore } from '../../src/retrieval/brute-force.store.js';
import { CORPUS_KINDS } from '../../src/retrieval/corpus.js';
import { type Embedder, OllamaLocalEmbedder } from '../../src/retrieval/embedder.js';
import { ingestCorpus } from '../../src/retrieval/ingest.js';
import { RetrievalService } from '../../src/retrieval/retrieval.service.js';
import {
  distinctInOrder,
  randomReciprocalRank,
  randomRecallAtK,
  reciprocalRank,
  recallAtK,
} from '../../src/retrieval/scoring.js';
import { seedSpeakers } from '../../src/retrieval/seed-speakers.js';
import { SpeakerSuggester } from '../../src/retrieval/suggest-speakers.js';
import {
  OPEN_GATES,
  type RelevanceGates,
  STRATEGIES,
  type Strategy,
  type VectorStore,
} from '../../src/retrieval/vector-store.js';
import { percentile } from '../../src/llm/usage.js';

const CasesSchema = z.object({
  k: z.number().int().positive(),
  cases: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      query: z.string(),
      kind: z.enum(CORPUS_KINDS).optional(),
      /** Documents that must come back. Omitted when the case only checks `forbid`. */
      expect: z.array(z.string()).optional(),
      /** Documents that must NEVER come back (e.g. personal content in a public search). */
      forbid: z.array(z.string()).optional(),
      /** Chunk ids that must come back: answers that sit in a non-first chunk of a split document. */
      expectChunks: z.array(z.string()).optional(),
    }),
  ),
  speakers: z.array(
    z.object({
      id: z.string(),
      topic: z.string(),
      expect: z.array(z.string()),
      mustNot: z.array(z.string()).optional(),
      /** The expected speaker must cite at least one of these chunk ids. */
      citeChunks: z.array(z.string()).optional(),
    }),
  ),
});

const EVAL_DB = 'mug_retrieval_eval';
const repoRoot = new URL('../../../', import.meta.url);

/** One embedder per provider; adding a vendor is a case here plus a class implementing Embedder. */
function buildEmbedder(ref: { provider: string; model: string }, config: AppConfig): Embedder {
  switch (ref.provider) {
    case 'ollama-local':
      return new OllamaLocalEmbedder(config.OLLAMA_LOCAL_BASE_URL, ref.model);
    default:
      throw new Error(`no embedder for provider ${ref.provider}`);
  }
}

interface Row {
  embedder: string;
  store: string;
  strategy: Strategy;
  caseId: string;
  expect: string[];
  got: string[];
  recall?: number;
  rr?: number;
  /** What a random ordering of the documents in scope would score on this case. */
  baselineRecall?: number;
  baselineRr?: number;
  /** Chunk-level, for cases whose answer is a specific chunk. */
  expectChunks?: string[];
  gotChunks?: string[];
  chunkRecall?: number;
  chunkRr?: number;
  emptyOk?: boolean;
  /** A forbidden document was returned. */
  leaked?: boolean;
  searchMs: number;
}

const fmt = (n: number | undefined, d = 2): string => (n === undefined ? 'n/a' : n.toFixed(d));
const mean = (xs: number[]): number | undefined =>
  xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;

async function prepare(db: Db, root: string): Promise<MongoSpeakersRepository> {
  await db.collection('speakers').createIndexes(INDEXES.speakers);
  const speakers = new MongoSpeakersRepository(db);
  await seedSpeakers(root, speakers); // the eval runs against seeded speakers, never fixtures
  return speakers;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { corpus: { type: 'string', default: 'corpus/sample' } },
  });
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  const root = fileURLToPath(new URL(values.corpus, repoRoot));
  const spec = CasesSchema.parse(
    JSON.parse(await readFile(new URL('evals/retrieval/cases.json', repoRoot), 'utf8')),
  );
  const gates: RelevanceGates = {
    minScore: config.VECTOR_MIN_SCORE,
    minCoverage: config.KEYWORD_MIN_COVERAGE,
  };
  const embedderRefs = config.EVAL_EMBEDDERS ?? [
    { provider: 'ollama-local' as const, model: config.EMBEDDING_MODEL },
  ];

  const appClient = await new MongoClient(config.MONGODB_URI).connect();
  const atlasClient = config.ATLAS_LOCAL_URI
    ? await new MongoClient(config.ATLAS_LOCAL_URI).connect()
    : undefined;
  const rows: Row[] = [];
  const corpusLines: string[] = [];
  const speakerLines: string[] = [];
  const scopeLines: string[] = [];
  let queryTokens = 0;
  try {
    const bfDb = appClient.db(EVAL_DB);
    const atlasDb = atlasClient?.db(EVAL_DB);
    const bfSpeakers = await prepare(bfDb, root);
    const atlasSpeakers = atlasDb ? await prepare(atlasDb, root) : undefined;

    for (const ref of embedderRefs) {
      const embedder = buildEmbedder(ref, config);
      const stores: VectorStore[] = [new BruteForceStore(bfDb, embedder.ref)];
      const atlas = atlasDb ? new AtlasVectorStore(atlasDb, embedder.ref) : undefined;
      // One embedding pass, written to both stores: the comparison measures the store, not the model.
      const ingest = await ingestCorpus(root, { embedder, stores, speakers: bfSpeakers });
      if (atlas && atlasSpeakers) {
        // Speaker ids differ per database: stamp the Atlas copy with its own ids, same vectors.
        const ids = new Map(
          (await atlasSpeakers.findMany({ limit: 200 })).items.map((s) => [s.handle, s._id]),
        );
        await atlas.upsert(
          ingest.chunkList.map((c) => {
            const atlasId = c.speakerHandle ? ids.get(c.speakerHandle) : undefined;
            return atlasId ? { ...c, speakerId: atlasId } : c;
          }),
        );
        await atlas.ensureSearchIndexes(ingest.dim);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const probe = await atlas.search({
            text: 'sharding',
            classification: ['public'],
            limit: 1,
            strategy: 'keyword',
            gates: OPEN_GATES,
          });
          if (probe.length > 0) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        stores.push(atlas);
      }
      const totalTokens = ingest.tokens;
      corpusLines.push(
        `| \`${embedder.ref}\` | ${String(ingest.documents)} | ${String(ingest.chunks)} | ${String(totalTokens)} | ${ingest.model} | ${String(ingest.dim)} |`,
      );

      // N for the random baseline: documents a public search (with the case's kind filter) can return.
      const publicChunks = ingest.chunkList.filter((c) => c.classification === 'public');
      const docsInScope = (kind?: string): number =>
        new Set(publicChunks.filter((c) => !kind || c.kind === kind).map((c) => c.documentId)).size;
      scopeLines.push(
        `\`${embedder.ref}\`: k = ${String(spec.k)}, N = ${String(docsInScope())} public documents (${String(publicChunks.length)} public chunks) of ${String(ingest.documents)} documents; k/N = ${(spec.k / docsInScope()).toFixed(2)}.`,
      );

      for (const c of spec.cases) {
        const q = await embedder.embedQuery(c.query);
        queryTokens += q.tokens;
        const vector = q.vectors[0] ?? [];
        for (const store of stores) {
          for (const strategy of STRATEGIES) {
            const started = performance.now();
            const hits = await store.search({
              text: c.query,
              classification: ['public'],
              limit: spec.k * 3,
              strategy,
              gates,
              ...(strategy === 'keyword'
                ? {}
                : { vector, queryModel: { model: q.model, dim: q.dim } }),
              ...(c.kind ? { kind: c.kind } : {}),
            });
            const searchMs = performance.now() - started;
            const got = distinctInOrder(hits.map((h) => h.chunk.documentId)).slice(0, spec.k);
            const expect = c.expect ?? [];
            const recall = c.expect ? recallAtK(got, expect, spec.k) : undefined;
            const rr = c.expect ? reciprocalRank(got, expect) : undefined;
            const all = distinctInOrder(hits.map((h) => h.chunk.documentId));
            const n = docsInScope(c.kind);
            const gotChunks = hits.map((h) => h.chunk.id).slice(0, spec.k);
            const chunkRecall = c.expectChunks
              ? recallAtK(gotChunks, c.expectChunks, spec.k)
              : undefined;
            const chunkRr = c.expectChunks ? reciprocalRank(gotChunks, c.expectChunks) : undefined;
            rows.push({
              embedder: embedder.ref,
              store: store.name,
              strategy,
              caseId: c.id,
              expect,
              got,
              ...(recall === undefined ? {} : { recall }),
              ...(rr === undefined ? {} : { rr }),
              ...(expect.length > 0
                ? {
                    baselineRecall: randomRecallAtK(n, spec.k),
                    baselineRr: randomReciprocalRank(n, expect.length),
                  }
                : {}),
              ...(c.expectChunks ? { expectChunks: c.expectChunks, gotChunks } : {}),
              ...(chunkRecall === undefined ? {} : { chunkRecall }),
              ...(chunkRr === undefined ? {} : { chunkRr }),
              ...(c.expect?.length === 0 ? { emptyOk: got.length === 0 } : {}),
              ...(c.forbid ? { leaked: c.forbid.some((f) => all.includes(f)) } : {}),
              searchMs,
            });
          }
        }
      }

      // Grounding of suggestSpeakers with the real model (brute-force store, default hybrid).
      if (config.OLLAMA_API_KEY) {
        const logger = new AppLogger({ ...config, LOG_LEVEL: 'warn' });
        const call = buildStructuredCall(config, buildProviders(config), logger);
        const suggester = new SpeakerSuggester(
          new RetrievalService(embedder, stores[0] as VectorStore, gates),
          bfSpeakers,
          call,
        );
        const handleOf = new Map(
          (await bfSpeakers.findMany({ limit: 200 })).items.map((s) => [s._id, s.handle ?? s.name]),
        );
        for (const s of spec.speakers) {
          try {
            const r = await suggester.suggest(s.topic);
            const handles = r.suggestions.map((x) => handleOf.get(x.speaker.id) ?? '?');
            const hitIds = new Set(r.hits.map((h) => h.chunk.id));
            const citationsReal = r.suggestions.every(
              (x) => x.citations.length > 0 && x.citations.every((c) => hitIds.has(c.id)),
            );
            const speakersReal = r.suggestions.every((x) => handleOf.has(x.speaker.id));
            const expectedOk =
              s.expect.length === 0
                ? handles.length === 0
                : s.expect.every((h) => handles.includes(h));
            const mustNotOk = (s.mustNot ?? []).every((h) => !handles.includes(h));
            const cited = r.suggestions.flatMap((x) => x.citations.map((c) => c.id));
            const citeOk = !s.citeChunks || s.citeChunks.some((id) => cited.includes(id));
            const pass = citationsReal && speakersReal && expectedOk && mustNotOk && citeOk;
            speakerLines.push(
              `| ${s.id} | ${s.topic} | ${handles.join(', ') || '(none)'} | ${cited.join('<br>') || '(none)'} | ${s.citeChunks ? (citeOk ? 'yes' : 'NO') : '-'} | ${citationsReal ? 'yes' : 'NO'} | ${speakersReal ? 'yes' : 'NO'} | ${pass ? 'PASS' : 'FAIL'} |`,
            );
          } catch (err) {
            speakerLines.push(
              `| ${s.id} | ${s.topic} | error: ${err instanceof Error ? err.name : 'unknown'} | - | - | - | - | FAIL |`,
            );
          }
        }
      }
    }
  } finally {
    await appClient.close();
    await atlasClient?.close();
  }

  // ---- report ---------------------------------------------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  const arms = [...new Set(rows.map((r) => `${r.embedder}|${r.store}|${r.strategy}`))];
  const lines: string[] = [`# Retrieval eval report (${date})`, ''];
  lines.push(
    `Corpus: \`${values.corpus}\`. Cases: ${String(spec.cases.length)}, k = ${String(spec.k)}. Scope: public. Vector threshold (VECTOR_MIN_SCORE): ${String(config.VECTOR_MIN_SCORE)}. Query embedding tokens: ${String(queryTokens)}.`,
    '',
  );
  lines.push(
    '## Scope and random baseline',
    '',
    ...scopeLines,
    '',
    'The baseline columns are what a ranker that orders the documents in scope at random would score on the same cases (recall@k = k/N per expected document, capped at 1; MRR = the expected 1/rank of the first expected document). A ranking difference between arms that is smaller than one case is not a measurement.',
    '',
  );
  lines.push(
    '## Corpus size',
    '',
    '| Embedder | Documents | Chunks | Tokens embedded | Model | Dim |',
    '|---|---|---|---|---|---|',
    ...corpusLines,
    '',
  );
  if (!config.ATLAS_LOCAL_URI)
    lines.push('> Atlas arm not run: set ATLAS_LOCAL_URI (npm run atlas:up).', '');
  lines.push(
    '## Summary per arm',
    '',
    '| Embedder | Store | Strategy | mean recall@k | random baseline recall@k | MRR | random baseline MRR | chunk recall@k (split cases) | chunk MRR (split cases) | no-answer cases correct | forbidden documents returned | median search | p95 search |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const arm of arms) {
    const [embedder, store, strategy] = arm.split('|');
    const mine = rows.filter((r) => `${r.embedder}|${r.store}|${r.strategy}` === arm);
    const recalls = mine.flatMap((r) => (r.recall === undefined ? [] : [r.recall]));
    const rrs = mine.flatMap((r) => (r.rr === undefined ? [] : [r.rr]));
    const pick = (f: (r: Row) => number | undefined): number[] =>
      mine.flatMap((r) => {
        const v = f(r);
        return v === undefined ? [] : [v];
      });
    const empties = mine.filter((r) => r.emptyOk !== undefined);
    const ms = mine.map((r) => r.searchMs);
    const leaks = mine.filter((r) => r.leaked === true).length;
    lines.push(
      `| \`${embedder ?? ''}\` | ${store ?? ''} | ${strategy ?? ''} | ${fmt(mean(recalls))} | ${fmt(mean(pick((r) => r.baselineRecall)))} | ${fmt(mean(rrs))} | ${fmt(mean(pick((r) => r.baselineRr)))} | ${fmt(mean(pick((r) => r.chunkRecall)))} | ${fmt(mean(pick((r) => r.chunkRr)))} | ${String(empties.filter((r) => r.emptyOk).length)}/${String(empties.length)} | ${String(leaks)} | ${fmt(percentile(ms, 50), 1)} ms | ${fmt(percentile(ms, 95), 1)} ms |`,
    );
  }
  lines.push(
    '',
    '## Per case',
    '',
    '| Case | Store | Strategy | Expected | Got (top k documents) | recall@k | RR |',
    '|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const verdict =
      (r.emptyOk === undefined ? '' : r.emptyOk ? ' (empty: correct)' : ' (should be empty)') +
      (r.leaked === undefined
        ? ''
        : r.leaked
          ? ' (FORBIDDEN DOCUMENT RETURNED)'
          : ' (forbidden document absent)');
    lines.push(
      `| ${r.caseId} | ${r.store} | ${r.strategy} | ${r.expect.join('<br>') || '(nothing)'} | ${r.got.join('<br>') || '(nothing)'}${verdict} | ${fmt(r.recall)} | ${fmt(r.rr)} |`,
    );
  }
  const splitRows = rows.filter((r) => r.expectChunks);
  if (splitRows.length > 0) {
    lines.push(
      '',
      '## Split documents: answers in a non-first chunk',
      '',
      '| Case | Store | Strategy | Expected chunk | Got (top k chunks) | chunk recall@k | chunk RR |',
      '|---|---|---|---|---|---|---|',
      ...splitRows.map(
        (r) =>
          `| ${r.caseId} | ${r.store} | ${r.strategy} | ${(r.expectChunks ?? []).join('<br>')} | ${(r.gotChunks ?? []).join('<br>') || '(nothing)'} | ${fmt(r.chunkRecall)} | ${fmt(r.chunkRr)} |`,
      ),
    );
  }
  lines.push('', '## suggestSpeakers grounding (real model)', '');
  if (speakerLines.length === 0) lines.push('Not run: OLLAMA_API_KEY is not set.');
  else
    lines.push(
      '| Case | Topic | Suggested | Cited chunks | Expected chunk cited | Citations real | Speakers real | Result |',
      '|---|---|---|---|---|---|---|---|',
      ...speakerLines,
    );
  lines.push('');
  const out = fileURLToPath(new URL(`report-${date}.md`, new URL('evals/retrieval/', repoRoot)));
  await writeFile(out, lines.join('\n'));
  console.log(`Report written to ${out}`);
  console.log(`Embedders: ${embedderRefs.map(formatEmbedderRef).join(', ')}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
