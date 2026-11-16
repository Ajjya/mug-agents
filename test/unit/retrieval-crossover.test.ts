import { describe, expect, it } from 'vitest';
import { crossoverOf, rng, unitVector } from '../../evals/retrieval/synthetic.js';

describe('crossover benchmark helpers', () => {
  it('synthetic vectors are deterministic, unit length and of the requested dimension', () => {
    const a = unitVector(rng(42), 768);
    const b = unitVector(rng(42), 768);
    expect(a).toEqual(b);
    expect(a).toHaveLength(768);
    expect(Math.hypot(...a)).toBeCloseTo(1, 12);
    expect(unitVector(rng(1), 3)).toHaveLength(3); // odd dimension
    // Random directions in 768 dimensions are nearly orthogonal.
    const c = unitVector(rng(43), 768);
    expect(Math.abs(a.reduce((s, x, i) => s + x * (c[i] ?? 0), 0))).toBeLessThan(0.2);
  });

  it('finds the crossover between the two sizes where the faster store flips', () => {
    // Brute force linear (0.04 ms/chunk), Atlas flat at 12 ms: equal at 300 chunks.
    const pts = [100, 1000, 10000].map((size) => ({ size, bf: 0.04 * size, atlas: 12 }));
    const c = crossoverOf(pts);
    expect(c).toMatchObject({ kind: 'between', lo: 100, hi: 1000 });
    expect(c.kind === 'between' ? c.estimate : 0).toBeCloseTo(300, 0);
  });

  it('says below or above when the flip is outside the measured sizes, none without data', () => {
    expect(crossoverOf([{ size: 1000, bf: 40, atlas: 13 }])).toEqual({ kind: 'below', size: 1000 });
    expect(
      crossoverOf([
        { size: 10, bf: 1, atlas: 13 },
        { size: 100, bf: 4, atlas: 13 },
      ]),
    ).toEqual({ kind: 'above', size: 100 });
    expect(crossoverOf([])).toEqual({ kind: 'none' });
  });
});
