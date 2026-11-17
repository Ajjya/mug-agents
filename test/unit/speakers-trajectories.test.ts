import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../../evals/speakers/scenarios.js';

// The trajectory evals (npm run eval:speakers) also run as tests: a wrong path fails the build.
describe('speakers trajectory evals', () => {
  it.each(SCENARIOS.map((s) => [s.name, s]))('%s', async (_name, scenario) => {
    const r = await scenario();
    expect(r.actual).toEqual(r.expected);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
