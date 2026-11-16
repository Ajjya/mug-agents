import { describe, expect, it } from 'vitest';
import {
  type ChunkView,
  type Hit,
  type RelevanceGates,
  type SearchQuery,
  decide,
  gateKeyword,
  gateVector,
  termCoverage,
} from '../../src/retrieval/vector-store.js';

const chunk = (id: string, text: string): ChunkView => ({
  id,
  documentId: id.split('#')[0] ?? id,
  index: 0,
  heading: 'Heading',
  text,
  kind: 'post',
  classification: 'public',
  date: '2026-03-12',
  embedder: 'stub:x',
  model: 'x',
  dim: 3,
});
const hit = (id: string, score: number, text = ''): Hit => ({ chunk: chunk(id, text), score });
const gates: RelevanceGates = { minScore: 0.5, minCoverage: 0.5 };
const query = (over: Partial<SearchQuery>): SearchQuery => ({
  text: 'pizza recipe pineapple anchovies',
  classification: ['public'],
  limit: 5,
  strategy: 'hybrid',
  gates,
  ...over,
});

describe('relevance gates: each strategy decides "nothing relevant" with its own rule', () => {
  it('vector: an absolute cosine per hit', () => {
    const r = gateVector([hit('a', 0.7), hit('b', 0.5), hit('c', 0.49)], gates);
    expect(r.hits.map((h) => h.chunk.id)).toEqual(['a', 'b']);
    expect(r.report).toEqual({ candidates: 3, top: 0.7, aboveMinScore: 2 });
    expect(gateVector([], gates).report).toEqual({ candidates: 0, top: null, aboveMinScore: 0 });
  });

  it('keyword: the share of distinct query terms a chunk contains, not the BM25 score', () => {
    expect(termCoverage('pizza recipe pineapple anchovies', chunk('x', 'Doors and pizza'))).toBe(
      0.25,
    );
    expect(termCoverage('the shard keys', chunk('x', 'choosing a shard key'))).toBe(1);
    expect(termCoverage('the and of', chunk('x', 'the and of'))).toBe(0); // stopwords only
    // A huge BM25 score does not get a one-word overlap through.
    const r = gateKeyword(
      'pizza recipe pineapple anchovies',
      [hit('one-word', 99, 'pizza pizza pizza'), hit('three-words', 1, 'pizza recipe anchovies')],
      gates,
    );
    expect(r.hits.map((h) => h.chunk.id)).toEqual(['three-words']);
    expect(r.report).toEqual({ candidates: 2, topCoverage: 0.75, aboveMinCoverage: 1 });
  });

  it('hybrid: fuses only what passed each arm, and has no threshold on the RRF score', () => {
    const vector = [hit('v-weak', 0.3)];
    const keyword = [hit('k-weak', 9, 'pizza')];
    const none = decide(query({ strategy: 'hybrid' }), { vector, keyword });
    expect(none.hits).toEqual([]);
    expect(none.vector?.aboveMinScore).toBe(0);
    expect(none.keyword?.aboveMinCoverage).toBe(0);
    // One arm passing is enough for hybrid: union of gated arms.
    const one = decide(query({ strategy: 'hybrid' }), {
      vector: [hit('v-strong', 0.8)],
      keyword,
    });
    expect(one.hits.map((h) => h.chunk.id)).toEqual(['v-strong']);
  });

  it('vector and keyword strategies report only the arm they ran', () => {
    const v = decide(query({ strategy: 'vector' }), { vector: [hit('a', 0.9)] });
    expect(v.keyword).toBeUndefined();
    expect(v.hits).toHaveLength(1);
    const k = decide(query({ strategy: 'keyword' }), {
      keyword: [hit('a', 1, 'pizza recipe')],
    });
    expect(k.vector).toBeUndefined();
    expect(k.hits).toHaveLength(1);
  });
});
