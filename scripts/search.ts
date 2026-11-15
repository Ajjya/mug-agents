import { parseArgs } from 'node:util';
import {
  CLASSIFICATIONS,
  CORPUS_KINDS,
  type Classification,
  type CorpusKind,
} from '../src/retrieval/corpus.js';
import { EmbeddingMismatchError, EmbeddingUnavailableError } from '../src/retrieval/embedder.js';
import { RetrievalService } from '../src/retrieval/retrieval.service.js';
import {
  STRATEGIES,
  type ClassificationScope,
  type Strategy,
} from '../src/retrieval/vector-store.js';
import { runCli } from './cli.js';

const USAGE =
  'Usage: npm run search -- "query" [--kind abstract] [--strategy vector|keyword|hybrid] [--limit 5] [--classification public|personal|public,personal]';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: 'string' },
    strategy: { type: 'string', default: 'hybrid' },
    limit: { type: 'string', default: '5' },
    classification: { type: 'string', default: 'public' },
  },
});
const query = positionals.join(' ').trim();
const scope = values.classification.split(',').map((s) => s.trim());
if (
  !query ||
  !(STRATEGIES as readonly string[]).includes(values.strategy) ||
  (values.kind !== undefined && !(CORPUS_KINDS as readonly string[]).includes(values.kind)) ||
  scope.length === 0 ||
  !scope.every((s) => (CLASSIFICATIONS as readonly string[]).includes(s))
) {
  console.error(USAGE);
  process.exit(2);
}

runCli(
  async (app) => {
    const hits = await app.get(RetrievalService, { strict: false }).search(query, {
      strategy: values.strategy as Strategy,
      limit: Number(values.limit),
      classification: scope as unknown as ClassificationScope & Classification[],
      ...(values.kind ? { kind: values.kind as CorpusKind } : {}),
    });
    if (hits.length === 0) {
      console.log(
        `Nothing in the corpus matches "${query}" (${values.strategy}, ${scope.join('+')}).`,
      );
      return 0;
    }
    console.log(
      `${String(hits.length)} hit(s) for "${query}" (${values.strategy}, ${scope.join('+')}):\n`,
    );
    hits.forEach((h, i) => {
      const c = h.chunk;
      console.log(
        `${String(i + 1)}. ${c.documentId}  [${c.kind}, ${c.classification}, ${c.date}]  score ${h.score.toFixed(4)}  chunk ${c.id}`,
      );
      console.log(`   ${c.heading}: ${c.text.replace(/\s+/g, ' ').slice(0, 160)}...`);
    });
    return 0;
  },
  (err) =>
    err instanceof EmbeddingUnavailableError || err instanceof EmbeddingMismatchError
      ? (console.error(err.message), 2)
      : undefined,
);
