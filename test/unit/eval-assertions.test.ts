import { describe, expect, it } from 'vitest';
import { assertDraft, firstFailure } from '../../evals/assertions.js';
import { renderReport, summariseModel, type CaseOutcome } from '../../evals/report.js';
import type { LlmCallRecord } from '../../src/llm/model.types.js';
import { brief, draft } from '../support/planner-fixtures.js';

const names = (d = draft()) =>
  assertDraft(d)
    .filter((r) => !r.pass)
    .map((r) => r.name);

describe('assertDraft', () => {
  it('passes a good plan', () => {
    expect(assertDraft(draft()).every((r) => r.pass)).toBe(true);
    expect(firstFailure(assertDraft(draft()))).toBeUndefined();
  });

  it('flags an incomplete or reordered timeline', () => {
    const d = draft();
    const bad = { ...d, timeline: { milestones: d.timeline.milestones.slice(1) } };
    expect(names(bad)).toContain('milestones-complete-and-ordered');
    expect(names(bad)).toContain('schemas-valid');
  });

  it('flags a task due after the event, but never the T+3d follow-up', () => {
    const d = draft(brief());
    // Pretend a milestone date drifted past the event: a code bug the eval must catch.
    const milestones = d.milestones.map((m) =>
      m.key === 'T-1w' ? { ...m, dateIso: '2027-02-01T00:00:00.000Z' } : m,
    );
    const withLate = {
      ...d,
      milestones,
      checklist: {
        tasks: [
          ...d.checklist.tasks,
          { milestone: 'T-1w' as const, title: 'Late one', owner: 'organiser' as const },
        ],
      },
    };
    expect(names(withLate)).toContain('due-dates-not-after-event');
    expect(names(draft())).not.toContain('due-dates-not-after-event'); // T+3d is after the event and fine
  });

  it('flags duplicate titles within a milestone', () => {
    const d = draft();
    const dup = {
      ...d,
      checklist: {
        tasks: [
          ...d.checklist.tasks,
          { milestone: 'T-8w' as const, title: 'confirm  VENUE', owner: 'organiser' as const },
        ],
      },
    };
    expect(names(dup)).toEqual(expect.arrayContaining(['no-duplicate-titles-per-milestone']));
  });
});

const call = (over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  node: 'n',
  model: 'ollama:a',
  attempt: 1,
  rung: 0,
  tokensIn: 100,
  tokensOut: 50,
  latencyMs: 2000,
  outcome: 'valid',
  constrained: false,
  ...over,
});
const outcome = (over: Partial<CaseOutcome>): CaseOutcome => ({
  caseId: 'c1',
  model: 'ollama:a',
  status: 'pass',
  calls: [call()],
  ...over,
});

describe('eval report', () => {
  it('keeps provider failures out of the pass rate and counts first-try passes', () => {
    const s = summariseModel(
      'ollama:a',
      [
        outcome({ caseId: 'c1' }),
        outcome({
          caseId: 'c2',
          calls: [call({ attempt: 1, outcome: 'invalid' }), call({ attempt: 2 })],
        }),
        outcome({ caseId: 'c3', status: 'fail', failure: 'x' }),
        outcome({
          caseId: 'c4',
          status: 'provider_failure',
          failure: 'HTTP 503',
          calls: [call({ outcome: 'unavailable', latencyMs: 0 })],
        }),
      ],
      { 'ollama:a': { inputPerMTok: 1, outputPerMTok: 2 } },
    );
    expect(s).toMatchObject({ pass: 2, fail: 1, providerFailures: 1, firstTryPasses: 1 });
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(s.cost).toBeGreaterThan(0);
  });

  it('renders a matrix with a provider-failure column, decoding mode and escaped pipes', () => {
    const md = renderReport({
      date: '2026-11-10',
      caseIds: ['c1'],
      models: [{ model: 'ollama:a', constrained: false }],
      outcomes: [outcome({ status: 'fail', failure: 'schemas-valid: a | b' })],
      prices: {},
      maxConcurrency: 3,
    });
    expect(md).toContain('| Provider failures |');
    expect(md).toContain('prompt-only');
    expect(md).toContain('a \\| b');
    expect(md).toContain('n/a (no price in LLM_PRICES)');
    expect(md).toContain('| c1 | `ollama:a` | FAIL |');
  });
});
