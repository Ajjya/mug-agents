import { describe, expect, it, vi } from 'vitest';
import {
  EmbeddingMismatchError,
  EmbeddingUnavailableError,
  OllamaLocalEmbedder,
  assertCompatible,
  normalize,
} from '../../src/retrieval/embedder.js';
import {
  bm25,
  randomReciprocalRank,
  randomRecallAtK,
  recallAtK,
  reciprocalRank,
  rrf,
  terms,
} from '../../src/retrieval/scoring.js';

describe('terms and bm25', () => {
  it('drops stopwords and question phrasing, keeps the content words', () => {
    expect(terms('Who talked about Sharding?')).toEqual(['sharding']);
    expect(terms('shard keys')).toEqual(['shard', 'key']);
  });

  it('ranks by term evidence and returns nothing when no term matches', () => {
    const items = ['change streams resume tokens', 'sharding and shard keys', 'pizza and drinks'];
    expect(bm25('shard key', items, (t) => t).map((s) => s.item)).toEqual([
      'sharding and shard keys',
    ]);
    expect(bm25('kubernetes operator', items, (t) => t)).toEqual([]);
    expect(bm25('the of and', items, (t) => t)).toEqual([]);
  });
});

describe('rrf', () => {
  it('fuses by rank, rewards items in both lists, and never invents an item', () => {
    const fused = rrf(
      [
        ['a', 'b', 'c'],
        ['b', 'd'],
      ],
      (x) => x,
    ).map((s) => s.item);
    expect(fused[0]).toBe('b');
    expect(new Set(fused)).toEqual(new Set(['a', 'b', 'c', 'd']));
    expect(rrf([[], []], (x: string) => x)).toEqual([]);
  });

  it('uses 1/(k+rank)', () => {
    const [top] = rrf([['a']], (x) => x, 60);
    expect(top?.score).toBeCloseTo(1 / 61);
  });
});

describe('recall@k and reciprocal rank', () => {
  it('compute on known inputs', () => {
    expect(recallAtK(['x', 'a', 'y', 'b'], ['a', 'b'], 2)).toBe(0.5);
    expect(recallAtK(['x', 'a', 'y', 'b'], ['a', 'b'], 4)).toBe(1);
    expect(recallAtK(['x'], ['a'], 5)).toBe(0);
    expect(reciprocalRank(['x', 'a'], ['a'])).toBe(0.5);
    expect(reciprocalRank(['a'], ['a'])).toBe(1);
    expect(reciprocalRank(['x', 'y'], ['a'])).toBe(0);
  });

  it('are undefined (not a free pass or a fail) when nothing is expected', () => {
    expect(recallAtK(['x'], [], 5)).toBeUndefined();
    expect(reciprocalRank(['x'], [])).toBeUndefined();
  });

  it('fail when the metric is wrong: an off-by-one cut-off or a position-blind rank is caught', () => {
    const wrongRecall = (ranked: string[], expected: string[], k: number) =>
      expected.filter((e) => ranked.slice(0, k + 1).includes(e)).length / expected.length;
    expect(wrongRecall(['x', 'a'], ['a'], 1)).not.toBe(recallAtK(['x', 'a'], ['a'], 1));
    const wrongRR = (ranked: string[], expected: string[]) =>
      ranked.some((r) => expected.includes(r)) ? 1 : 0;
    expect(wrongRR(['x', 'a'], ['a'])).not.toBe(reciprocalRank(['x', 'a'], ['a']));
  });
});

describe('embedder', () => {
  it('normalises to unit length and refuses a zero vector', () => {
    expect(Math.hypot(...normalize([3, 4]))).toBeCloseTo(1);
    expect(() => normalize([0, 0])).toThrow(RangeError);
  });

  it('refuses a query from a different model or dimension than the index', () => {
    expect(() => {
      assertCompatible(
        { model: 'nomic-embed-text', dim: 768 },
        { model: 'nomic-embed-text', dim: 768 },
      );
    }).not.toThrow();
    expect(() => {
      assertCompatible(
        { model: 'nomic-embed-text', dim: 768 },
        { model: 'embeddinggemma', dim: 768 },
      );
    }).toThrow(EmbeddingMismatchError);
    expect(() => {
      assertCompatible(
        { model: 'nomic-embed-text', dim: 768 },
        { model: 'nomic-embed-text', dim: 512 },
      );
    }).toThrow(/768 dims/);
  });

  it('talks to local Ollama only: /api/embed, truncate false, nomic task prefixes, dim from the response', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[3, 4, 0]], prompt_eval_count: 7 }), {
        status: 200,
      }),
    );
    const e = new OllamaLocalEmbedder('http://127.0.0.1:11434', 'nomic-embed-text', f);
    const r = await e.embedQuery('change streams');
    expect(r).toMatchObject({ model: 'nomic-embed-text', dim: 3, tokens: 7 });
    expect(r.vectors[0]?.[0]).toBeCloseTo(0.6);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
    const body = JSON.parse(init?.body as string) as { input: string[]; truncate: boolean };
    expect(body.truncate).toBe(false);
    expect(body.input).toEqual(['search_query: change streams']);
    expect(e.ref).toBe('ollama-local:nomic-embed-text');
  });

  it('gives an actionable error when Ollama is not running or the model is missing', async () => {
    const down = new OllamaLocalEmbedder(
      'http://127.0.0.1:1',
      'nomic-embed-text',
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
    );
    await expect(down.embedQuery('x')).rejects.toThrow(/ollama serve/);
    const missing = new OllamaLocalEmbedder(
      'http://x',
      'nope',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 404 })),
    );
    await expect(missing.embedQuery('x')).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    await expect(missing.embedQuery('x')).rejects.toThrow(/ollama pull nope/);
  });
});

describe('random baselines', () => {
  it('recall@k of a random ranking is k/n, capped at 1', () => {
    expect(randomRecallAtK(9, 5)).toBeCloseTo(5 / 9);
    expect(randomRecallAtK(1, 5)).toBe(1);
    expect(randomRecallAtK(0, 5)).toBe(0);
  });

  it('reciprocal rank of a random ranking matches enumeration', () => {
    // One target among 9: (1/9) * H9.
    let h9 = 0;
    for (let i = 1; i <= 9; i++) h9 += 1 / i;
    expect(randomReciprocalRank(9, 1)).toBeCloseTo(h9 / 9, 10);
    // Two targets among 9, by brute force over all placements.
    let sum = 0;
    let count = 0;
    for (let a = 1; a <= 9; a++)
      for (let b = 1; b <= 9; b++)
        if (a !== b) {
          sum += 1 / Math.min(a, b);
          count++;
        }
    expect(randomReciprocalRank(9, 2)).toBeCloseTo(sum / count, 10);
    expect(randomReciprocalRank(1, 1)).toBe(1);
    expect(randomReciprocalRank(3, 3)).toBe(1);
  });
});
