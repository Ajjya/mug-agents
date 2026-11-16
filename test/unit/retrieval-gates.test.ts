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
const gates: RelevanceGates = { minScore: 0.5, minGap: 0, minCoverage: 0.5 };
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
    expect(r.report).toMatchObject({ candidates: 3, top: 0.7, aboveMinScore: 2, gapGate: 'n/a' });
    expect(gateVector([], gates).report).toMatchObject({
      candidates: 0,
      top: null,
      aboveMinScore: 0,
      median: null,
      gap: null,
    });
  });

  it('vector gap gate: scale-free, top minus the median of the retrieved set', () => {
    const g: RelevanceGates = { minScore: 0.5, minGap: 0.1, minCoverage: 0.5 };
    // Flat: everything about equally similar. Passes the absolute gate, fails the gap gate.
    const flat = gateVector(
      [0.62, 0.61, 0.6, 0.6, 0.59].map((s, i) => hit(String(i), s)),
      g,
    );
    expect(flat.hits).toEqual([]);
    expect(flat.report).toMatchObject({ aboveMinScore: 5, median: 0.6, gapGate: 'reject' });
    expect(flat.report.gap).toBeCloseTo(0.02);
    // One chunk stands out: both gates pass.
    const peaked = gateVector(
      [0.8, 0.6, 0.55, 0.5, 0.45].map((s, i) => hit(String(i), s)),
      g,
    );
    expect(peaked.report.gapGate).toBe('pass');
    expect(peaked.hits.map((h) => h.chunk.id)).toEqual(['0', '1', '2', '3']);
    // The same shape shifted down a whole band: the gap gate's decision does not change.
    const shifted = gateVector(
      [0.5, 0.3, 0.25, 0.2, 0.15].map((s, i) => hit(String(i), s)),
      { ...g, minScore: -1 },
    );
    expect(shifted.report.gapGate).toBe('pass');
    // Even median for an even set; too small a set means "n/a", not a decision.
    expect(
      gateVector(
        [0.9, 0.5, 0.4, 0.3, 0.2, 0.1].map((s, i) => hit(String(i), s)),
        g,
      ).report.median,
    ).toBeCloseTo(0.35);
    const small = gateVector([hit('a', 0.9), hit('b', 0.89)], g);
    expect(small.report.gapGate).toBe('n/a');
    expect(small.hits).toHaveLength(2);
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
