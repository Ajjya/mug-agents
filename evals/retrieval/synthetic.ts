/** Pure helpers of the crossover benchmark, kept apart so they are unit-tested. */

/** Deterministic PRNG (mulberry32): the same seed gives the same corpus and queries on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random direction: Gaussian components (Box-Muller), normalised to unit length. */
export function unitVector(next: () => number, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < dim; i += 2) {
    const r = Math.sqrt(-2 * Math.log(next() || 1e-12));
    const t = 2 * Math.PI * next();
    v[i] = r * Math.cos(t);
    if (i + 1 < dim) v[i + 1] = r * Math.sin(t);
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

export type Crossover =
  | { kind: 'none' }
  | { kind: 'below'; size: number }
  | { kind: 'above'; size: number }
  | { kind: 'between'; lo: number; hi: number; estimate: number };

/**
 * Where the median latencies cross: the first size at which Atlas is faster, interpolated between it
 * and the previous size on log(size) against log(brute force / Atlas). Sizes ascending.
 */
export function crossoverOf(
  points: readonly { size: number; bf: number; atlas: number }[],
): Crossover {
  const d = points.map((p) => ({ size: p.size, d: Math.log(p.bf) - Math.log(p.atlas) }));
  const at = d.findIndex((p) => p.d > 0);
  const first = d[0];
  const last = d.at(-1);
  if (!first || !last) return { kind: 'none' };
  if (at === 0) return { kind: 'below', size: first.size };
  if (at === -1) return { kind: 'above', size: last.size };
  const a = d[at - 1];
  const b = d[at];
  if (!a || !b) return { kind: 'none' };
  const t = -a.d / (b.d - a.d);
  return {
    kind: 'between',
    lo: a.size,
    hi: b.size,
    estimate: Math.exp(Math.log(a.size) + t * (Math.log(b.size) - Math.log(a.size))),
  };
}
