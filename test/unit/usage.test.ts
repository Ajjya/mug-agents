import { describe, expect, it } from 'vitest';
import type { LlmCallRecord } from '../../src/llm/model.types.js';
import { callCost, percentile, summariseCalls } from '../../src/llm/usage.js';

const rec = (
  model: string,
  tokensIn: number,
  tokensOut: number,
  latencyMs = 10,
): LlmCallRecord => ({
  node: 'n',
  model,
  attempt: 1,
  rung: 0,
  tokensIn,
  tokensOut,
  latencyMs,
  outcome: 'valid',
  constrained: false,
});
const prices = { 'ollama:a': { inputPerMTok: 1, outputPerMTok: 2 } };

describe('usage', () => {
  it('prices a call from the configured map', () => {
    expect(callCost(rec('ollama:a', 1_000_000, 500_000), prices)).toBeCloseTo(2);
    expect(callCost(rec('ollama:unpriced', 1, 1), prices)).toBeUndefined();
  });

  it('sums tokens and cost; cost is undefined if any call is unpriced', () => {
    const s = summariseCalls(
      [rec('ollama:a', 1_000_000, 0), rec('ollama:a', 0, 1_000_000)],
      prices,
    );
    expect(s).toMatchObject({ calls: 2, tokensIn: 1_000_000, tokensOut: 1_000_000, latencyMs: 20 });
    expect(s.cost).toBeCloseTo(3);
    expect(
      summariseCalls([rec('ollama:a', 1, 1), rec('ollama:b', 1, 1)], prices).cost,
    ).toBeUndefined();
  });

  it('computes percentiles (nearest rank)', () => {
    const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(100);
    expect(percentile([], 50)).toBe(0);
  });
});
