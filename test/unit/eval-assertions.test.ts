import { describe, expect, it } from 'vitest';
import { assertDraft, firstFailure } from '../../evals/assertions.js';
import {
  ENSURE_PLANNED_IDEMPOTENT,
  PERSIST_IDEMPOTENT,
  evaluateEnsurePlanned,
  evaluatePersist,
  idempotencyAssertions,
} from '../../evals/idempotency.js';
import { renderReport, summariseModel, type CaseOutcome } from '../../evals/report.js';
import type { LlmCallRecord } from '../../src/llm/model.types.js';
import { NOW, brief, draft } from '../support/planner-fixtures.js';

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

describe('idempotency assertions', () => {
  const raw = { theme: brief().theme, date: '2027-01-12', format: 'talks', capacity: 80 };

  it('are named for what they actually check', () => {
    expect(PERSIST_IDEMPOTENT).toBe('persist-is-idempotent-for-the-same-draft');
    expect(ENSURE_PLANNED_IDEMPOTENT).toBe('ensure-planned-is-idempotent-for-the-same-brief');
  });

  it('both pass for a good draft, and the old name is gone', async () => {
    const results = await idempotencyAssertions(draft(), raw, NOW);
    expect(results.map((r) => r.name)).toEqual([PERSIST_IDEMPOTENT, ENSURE_PLANNED_IDEMPOTENT]);
    expect(results.every((r) => r.pass)).toBe(true);
    expect(results.map((r) => r.name)).not.toContain('rerun-creates-no-additional-tasks');
  });

  it('evaluatePersist fails when the second persist adds tasks', () => {
    const bad = evaluatePersist({
      firstCreated: 5,
      secondCreated: 5,
      totalAfterFirst: 5,
      totalAfterSecond: 10,
    });
    expect(bad.pass).toBe(false);
    expect(bad.detail).toContain('5 -> 10');
  });

  it('evaluateEnsurePlanned fails if the second call plans again or reaches the model', () => {
    const ok = {
      firstStatus: 'awaiting_approval',
      secondStatus: 'already_planned',
      modelCalls: 2,
      expectedModelCalls: 2,
      totalAfterFirst: 5,
      totalAfterSecond: 5,
    } as const;
    expect(evaluateEnsurePlanned(ok).pass).toBe(true);
    const again = evaluateEnsurePlanned({
      ...ok,
      secondStatus: 'awaiting_approval',
      modelCalls: 4,
      totalAfterSecond: 9,
    });
    expect(again.pass).toBe(false);
    expect(again.detail).toContain("second call returned 'awaiting_approval'");
    expect(again.detail).toContain('model ran 4 times');
    expect(evaluateEnsurePlanned({ ...ok, firstStatus: 'already_planned' }).pass).toBe(false);
  });
});
