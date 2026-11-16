/**
 * Keyword scoring for the brute-force arm, reciprocal rank fusion for hybrid, and the eval metrics.
 * All pure.
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how i if in into is it ' +
    'its last me my of on or our out so than that the their them then there these they this to us was we ' +
    'were what when where which who whom why will with would you your about any some talk talked talks ' +
    'spoke speak speaking give gave said tell told should'
  ).split(' '),
);

/** Lower-case word tokens, stopwords removed, light plural/inflection stripping. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('ies') ? `${t.slice(0, -3)}y` : t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * BM25 over the candidate set (k1 1.2, b 0.75). Only items that contain at least one query term are
 * returned: no match means not relevant, never "least bad".
 */
export function bm25<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
): Scored<T>[] {
  const q = [...new Set(terms(query))];
  if (q.length === 0 || items.length === 0) return [];
  const docs = items.map((item) => ({ item, toks: terms(textOf(item)) }));
  const avg = docs.reduce((n, d) => n + d.toks.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.toks.includes(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map(({ item, toks }) => {
      let score = 0;
      for (const t of q) {
        const tf = toks.filter((x) => x === t).length;
        if (tf === 0) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * toks.length) / avg));
      }
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score);
}

/** The constant from Cormack et al. (2009); 60 is the standard choice. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: score(d) = sum over lists of 1 / (k + rank). It uses ranks only, so it needs
 * no calibration between a cosine and a BM25 score that live on different scales. An item appears in
 * the fused list only if some input list contains it, so fusion never invents a hit.
 */
export function rrf<T>(
  lists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  k: number = RRF_K,
): Scored<T>[] {
  const acc = new Map<string, Scored<T>>();
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = keyOf(item);
      const prev = acc.get(key);
      const add = 1 / (k + i + 1);
      acc.set(key, { item: prev?.item ?? item, score: (prev?.score ?? 0) + add });
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/** Fraction of the expected ids found in the first k results. Undefined when nothing is expected. */
export function recallAtK(
  ranked: readonly string[],
  expected: readonly string[],
  k: number,
): number | undefined {
  if (expected.length === 0) return undefined;
  const top = new Set(ranked.slice(0, k));
  return expected.filter((e) => top.has(e)).length / expected.length;
}

/** 1 / rank of the first expected id (0 if none appears). Undefined when nothing is expected. */
export function reciprocalRank(
  ranked: readonly string[],
  expected: readonly string[],
): number | undefined {
  if (expected.length === 0) return undefined;
  const want = new Set(expected);
  const i = ranked.findIndex((r) => want.has(r));
  return i === -1 ? 0 : 1 / (i + 1);
}

/**
 * Expected recall@k of a ranker that orders the n candidates at random: each expected id lands in the
 * top k with probability k/n. The floor every recall number must be read against.
 */
export function randomRecallAtK(n: number, k: number): number {
  return n <= 0 ? 0 : Math.min(1, k / n);
}

/**
 * Expected reciprocal rank of the first of m expected ids when n candidates are ordered at random:
 * sum over r of (1/r) * P(the best-placed expected id is at rank r).
 */
export function randomReciprocalRank(n: number, m: number): number {
  if (n <= 0 || m <= 0) return 0;
  const hits = Math.min(m, n);
  let expected = 0;
  // P(min rank = r) = C(n - r, hits - 1) / C(n, hits)
  let pNoneBefore = 1; // P(no expected id in ranks 1..r-1)
  for (let r = 1; r <= n - hits + 1; r++) {
    const pHere = hits / (n - r + 1); // P(rank r is expected | none before)
    expected += (pNoneBefore * pHere) / r;
    pNoneBefore *= 1 - pHere;
  }
  return expected;
}

/** Distinct values in first-seen order (chunk hits -> document ranking). */
export const distinctInOrder = (values: readonly string[]): string[] => [...new Set(values)];
