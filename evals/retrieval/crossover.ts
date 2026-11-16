import 'reflect-metadata';
import { statfs, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getHeapStatistics } from 'node:v8';
import { type Db, MongoClient } from 'mongodb';
import { loadConfig } from '../../src/config/config.module.js';
import { percentile } from '../../src/llm/usage.js';
import { AtlasVectorStore } from '../../src/retrieval/atlas-vector.store.js';
import { BruteForceStore } from '../../src/retrieval/brute-force.store.js';
import {
  OPEN_GATES,
  type SearchQuery,
  type VectorStore,
  collectionFor,
} from '../../src/retrieval/vector-store.js';
import { crossoverOf, rng, unitVector } from './synthetic.js';

/**
 * Brute-force vs Atlas `$vectorSearch` latency at synthetic scale, without any embedding model:
 * random unit vectors (768 dimensions, like nomic-embed-text) loaded into both stores exactly as the
 * stores keep chunks, then the same random query vectors against each. Each size is loaded, measured
 * and dropped before the next, one store at a time, so peak disk is one store at one size.
 *
 *   npm run atlas:up
 *   ATLAS_LOCAL_URI=... npm run bench:crossover -- --sizes 10000,100000,1000000 --queries 20
 *
 * A size whose estimated footprint does not fit (disk, or the Node heap brute force needs: it loads
 * every in-scope vector per query) is reported as not run, with the numbers, instead of being tried.
 */

const DIM = 768;
const BENCH_DB = 'mug_retrieval_bench';
const EMBEDDER_REF = 'bench:random-768';
const repoRoot = new URL('../../../', import.meta.url);
/** BSON array element: type byte + index key (up to 3 digits + NUL) + float64. */
const BYTES_PER_DOC = DIM * 13 + 400;
/** Packed float64 arrays in V8 plus the decoded document around them. */
const HEAP_BYTES_PER_DOC = DIM * 8 * 2 + 1000;
/** mongot HNSW, float32 and graph links, generously. */
const INDEX_BYTES_PER_DOC = DIM * 4 * 2;
const DISK_HEADROOM = 10 * 1024 ** 3;
const GB = (b: number): string => `${(b / 1024 ** 3).toFixed(1)} GB`;

async function load(db: Db, size: number): Promise<number> {
  const col = db.collection(collectionFor(EMBEDDER_REF));
  const next = rng(42);
  const started = performance.now();
  const now = new Date();
  for (let i = 0; i < size; i += 1000) {
    const batch = [];
    for (let j = i; j < Math.min(size, i + 1000); j++) {
      batch.push({
        _id: `bench/${String(j)}#0` as unknown as never,
        documentId: `bench/${String(j)}`,
        index: 0,
        heading: 'synthetic',
        text: `synthetic chunk ${String(j)}`,
        kind: 'abstract',
        classification: 'public',
        date: '2026-01-01',
        embedder: EMBEDDER_REF,
        model: 'random-768',
        dim: DIM,
        vector: unitVector(next, DIM),
        retired: false,
        ingestedAt: now,
      });
    }
    await col.insertMany(batch, { ordered: false });
  }
  return performance.now() - started;
}

function query(vector: number[]): SearchQuery {
  return {
    text: 'synthetic',
    vector,
    queryModel: { model: 'random-768', dim: DIM },
    classification: ['public'],
    limit: 5,
    strategy: 'vector',
    gates: OPEN_GATES,
  };
}

async function measure(
  store: VectorStore,
  queries: number[][],
): Promise<{ ms: number[]; top: string[][] }> {
  await store.search(query(queries[0] ?? [])); // warm-up, not counted
  const ms: number[] = [];
  const top: string[][] = [];
  for (const q of queries) {
    const started = performance.now();
    const hits = await store.search(query(q));
    ms.push(performance.now() - started);
    top.push(hits.map((h) => h.chunk.id));
  }
  return { ms, top };
}

/** Waits until $vectorSearch finds a stored vector as its own best match: the index has caught up. */
async function waitIndexed(store: AtlasVectorStore, db: Db, size: number): Promise<number> {
  const started = performance.now();
  await store.ensureSearchIndexes(DIM, 60 * 60_000);
  const col = db.collection(collectionFor(EMBEDDER_REF));
  const last = await col.findOne({ _id: `bench/${String(size - 1)}#0` as unknown as never });
  const v = (last?.['vector'] as number[] | undefined) ?? [];
  for (;;) {
    const hits = await store.search(query(v));
    if (hits[0]?.chunk.id === `bench/${String(size - 1)}#0`) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return performance.now() - started;
}

interface Result {
  size: number;
  bf?: { median: number; p95: number; loadMs: number } | string;
  atlas?: { median: number; p95: number; loadMs: number; indexMs: number; recall: number } | string;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      sizes: { type: 'string', default: '10000,100000,1000000' },
      queries: { type: 'string', default: '20' },
    },
  });
  const config = loadConfig();
  if (!config.ATLAS_LOCAL_URI) {
    console.error('ATLAS_LOCAL_URI is required (npm run atlas:up)');
    return 1;
  }
  const sizes = values.sizes.split(',').map((s) => Number.parseInt(s, 10));
  const queryCount = Number.parseInt(values.queries, 10);
  const nextQuery = rng(7);
  const queries = Array.from({ length: queryCount }, () => unitVector(nextQuery, DIM));
  const appClient = await new MongoClient(config.MONGODB_URI).connect();
  const atlasClient = await new MongoClient(config.ATLAS_LOCAL_URI).connect();
  const results: Result[] = [];
  const heapLimit = getHeapStatistics().heap_size_limit;
  try {
    for (const size of sizes) {
      const r: Result = { size };
      results.push(r);
      const fs = await statfs(fileURLToPath(repoRoot));
      const free = fs.bavail * fs.bsize;
      const bfDisk = size * BYTES_PER_DOC;
      const atlasDisk = size * (BYTES_PER_DOC + INDEX_BYTES_PER_DOC);
      const heap = size * HEAP_BYTES_PER_DOC;
      console.log(`size ${String(size)}: free disk ${GB(free)}`);

      // ---- brute force ----
      let exact: string[][] | undefined;
      if (bfDisk + DISK_HEADROOM > free) {
        r.bf = `not run: needs ~${GB(bfDisk)} on disk, ${GB(free)} free (keeping ${GB(DISK_HEADROOM)} headroom)`;
      } else if (heap > heapLimit * 0.8) {
        r.bf = `not run: loads every vector per query, ~${GB(heap)} of heap; Node heap limit is ${GB(heapLimit)}`;
      } else {
        const db = appClient.db(BENCH_DB);
        await db.dropDatabase();
        const loadMs = await load(db, size);
        const m = await measure(new BruteForceStore(db, EMBEDDER_REF), queries);
        exact = m.top;
        r.bf = { median: percentile(m.ms, 50), p95: percentile(m.ms, 95), loadMs };
        await db.dropDatabase();
        console.log(`  bruteforce median ${r.bf.median.toFixed(1)} ms`);
      }

      // ---- atlas ----
      if (atlasDisk + DISK_HEADROOM > free) {
        r.atlas = `not run: needs ~${GB(atlasDisk)} on disk (documents + vector index), ${GB(free)} free (keeping ${GB(DISK_HEADROOM)} headroom)`;
      } else {
        const db = atlasClient.db(BENCH_DB);
        await db.dropDatabase();
        const loadMs = await load(db, size);
        const store = new AtlasVectorStore(db, EMBEDDER_REF, 2000);
        const indexMs = await waitIndexed(store, db, size);
        const m = await measure(store, queries);
        // ANN quality against the exact top 5 from brute force, when that ran.
        let found = 0;
        let wanted = 0;
        m.top.forEach((ids, i) => {
          const truth = exact?.[i] ?? [];
          wanted += truth.length;
          found += truth.filter((id) => ids.includes(id)).length;
        });
        r.atlas = {
          median: percentile(m.ms, 50),
          p95: percentile(m.ms, 95),
          loadMs,
          indexMs,
          recall: wanted === 0 ? Number.NaN : found / wanted,
        };
        await db.dropDatabase();
        console.log(`  atlas median ${r.atlas.median.toFixed(1)} ms`);
      }
    }
  } finally {
    await appClient.close();
    await atlasClient.close();
  }

  // ---- report ----
  const ms = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n.toFixed(1)} ms`;
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `Synthetic, no embedding model: random unit vectors, ${String(DIM)} dimensions, stored exactly as the stores keep chunks (BSON array of float64). ${String(queryCount)} random query vectors per size after one warm-up, \`vector\` strategy, limit 5, public scope, gates open. Brute force: local mongod (\`MONGODB_URI\`), similarity in Node. Atlas: mongodb-atlas-local 9.0.4, \`$vectorSearch\` dotProduct, quantization none, numCandidates 1000. Each size is loaded, measured and dropped one store at a time. p95 over ${String(queryCount)} samples is a rough figure. Random vectors are the worst case for an ANN index (no cluster structure), so the recall column is a floor.`,
    '',
    '| Chunks | brute force median | brute force p95 | Atlas median | Atlas p95 | Atlas recall@5 vs exact | load (brute force / Atlas) | Atlas index build |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const bf = typeof r.bf === 'object' ? r.bf : undefined;
    const at = typeof r.atlas === 'object' ? r.atlas : undefined;
    lines.push(
      `| ${r.size.toLocaleString('en-US')} | ${bf ? ms(bf.median) : '-'} | ${bf ? ms(bf.p95) : '-'} | ${at ? ms(at.median) : '-'} | ${at ? ms(at.p95) : '-'} | ${at && !Number.isNaN(at.recall) ? at.recall.toFixed(2) : '-'} | ${bf ? ms(bf.loadMs) : '-'} / ${at ? ms(at.loadMs) : '-'} | ${at ? ms(at.indexMs) : '-'} |`,
    );
  }
  const notRun = results.flatMap((r) => [
    ...(typeof r.bf === 'string'
      ? [`- ${r.size.toLocaleString('en-US')}, brute force: ${r.bf}.`]
      : []),
    ...(typeof r.atlas === 'string'
      ? [`- ${r.size.toLocaleString('en-US')}, Atlas: ${r.atlas}.`]
      : []),
  ]);
  if (notRun.length > 0) lines.push('', '**Not run:**', '', ...notRun);
  const c = crossoverOf(
    results.flatMap((r) =>
      typeof r.bf === 'object' && typeof r.atlas === 'object'
        ? [{ size: r.size, bf: r.bf.median, atlas: r.atlas.median }]
        : [],
    ),
  );
  const n = (x: number): string => x.toLocaleString('en-US');
  const crossover =
    c.kind === 'none'
      ? 'not measured: no size ran on both stores.'
      : c.kind === 'below'
        ? `Atlas is already faster at the smallest size measured on both stores (${n(c.size)} chunks): the crossover is below it.`
        : c.kind === 'above'
          ? `brute force is still faster at the largest size measured on both stores (${n(c.size)} chunks): the crossover is above it.`
          : `between ${n(c.lo)} and ${n(c.hi)} chunks; interpolated on log size and log latency ratio, about **${n(Number(c.estimate.toPrecision(2)))} chunks**.`;
  lines.push('', `**Crossover (median latency):** ${crossover}`, '');
  const out = fileURLToPath(new URL(`evals/retrieval/crossover-${date}.md`, repoRoot));
  await writeFile(out, lines.join('\n'));
  console.log(`Written to ${out}`);
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
