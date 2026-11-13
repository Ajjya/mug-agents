import { describe, expect, it } from 'vitest';
import {
  ApprovalDecisionInputSchema,
  ApprovalRequestInputSchema,
  DecisionValueSchema,
} from '../../src/approvals/approval.schema.js';
import {
  PlanReviewPayloadSchema,
  assertEditAllowed,
  InvalidEditError,
} from '../../src/approvals/plan-review.payload.js';
import { toStorage } from '../../src/domain/common.js';
import {
  approvalDecisionInput,
  approvalRequestInput,
  planReviewPayload,
} from '../support/approval-fixtures.js';

const ok = (r: { success: boolean }) => r.success;

describe('PlanReviewPayloadSchema (the interrupt contract)', () => {
  it('accepts a well-formed payload and is strict about extra keys', () => {
    expect(ok(PlanReviewPayloadSchema.safeParse(planReviewPayload()))).toBe(true);
    expect(ok(PlanReviewPayloadSchema.safeParse({ ...planReviewPayload(), state: {} }))).toBe(
      false,
    );
    expect(ok(PlanReviewPayloadSchema.safeParse({ ...planReviewPayload(), prompt: 'x' }))).toBe(
      false,
    );
  });

  it('carries only the timeline and checklist: no ids but the event, no model metadata', () => {
    const keys = Object.keys(planReviewPayload()).sort();
    expect(keys).toEqual(['checklist', 'eventId', 'milestones', 'theme']);
    expect(JSON.stringify(planReviewPayload())).not.toMatch(
      /tokens|latency|model|prompt|_id|version/,
    );
  });

  it('rejects a missing/reordered milestone, an unknown owner and duplicate titles', () => {
    const p = planReviewPayload();
    expect(ok(PlanReviewPayloadSchema.safeParse({ ...p, milestones: p.milestones.slice(1) }))).toBe(
      false,
    );
    expect(
      ok(PlanReviewPayloadSchema.safeParse({ ...p, milestones: [...p.milestones].reverse() })),
    ).toBe(false);
    const first = p.checklist[0];
    if (!first) throw new Error('fixture');
    expect(
      ok(PlanReviewPayloadSchema.safeParse({ ...p, checklist: [{ ...first, owner: 'alice' }] })),
    ).toBe(false);
    expect(
      ok(
        PlanReviewPayloadSchema.safeParse({
          ...p,
          checklist: [first, { ...first, title: first.title.toUpperCase() }],
        }),
      ),
    ).toBe(false);
    expect(ok(PlanReviewPayloadSchema.safeParse({ ...p, checklist: [] }))).toBe(false);
  });
});

describe('assertEditAllowed', () => {
  it('allows editing goals, work and the checklist', () => {
    const p = planReviewPayload();
    const edited = structuredClone(p);
    const m = edited.milestones[0];
    if (!m) throw new Error('fixture');
    m.goal = 'A better goal';
    m.work = ['Do the new thing'];
    edited.checklist = [{ milestone: 'T-8w', title: 'Only this', owner: 'organiser' }];
    expect(() => {
      assertEditAllowed(p, edited);
    }).not.toThrow();
  });

  it('refuses a changed date, label, event or theme: those are computed, not edited', () => {
    const p = planReviewPayload();
    const dated = structuredClone(p);
    const m = dated.milestones[2];
    if (!m) throw new Error('fixture');
    m.dateIso = '2030-01-01T00:00:00.000Z';
    expect(() => {
      assertEditAllowed(p, dated);
    }).toThrow(InvalidEditError);
    expect(() => {
      assertEditAllowed(p, dated);
    }).toThrow(/computed in code/);
    expect(() => {
      assertEditAllowed(p, { ...p, eventId: 'b'.repeat(24) });
    }).toThrow(/eventId/);
    expect(() => {
      assertEditAllowed(p, { ...p, theme: 'Something else' });
    }).toThrow(/theme/);
  });
});

describe('approval request schema', () => {
  it('accepts a request, encodes ids/dates for storage, and is strict', () => {
    const input = approvalRequestInput();
    expect(
      ok(ApprovalRequestInputSchema.safeParse(toStorage(ApprovalRequestInputSchema, input))),
    ).toBe(true);
    expect(() =>
      toStorage(ApprovalRequestInputSchema, { ...input, status: 'nope' as never }),
    ).toThrow();
    expect(() => toStorage(ApprovalRequestInputSchema, { ...input, extra: 1 } as never)).toThrow();
  });
});

describe('approval decision schema: conditional requirements', () => {
  const parse = (over: Parameters<typeof approvalDecisionInput>[0]) =>
    ApprovalDecisionInputSchema.safeParse(
      toStorage(
        ApprovalDecisionInputSchema,
        approvalDecisionInput({ decision: 'approve', ...over }),
      ),
    );

  it('approve: carries neither editedPayload nor reason', () => {
    expect(ok(parse({}))).toBe(true);
    expect(() =>
      toStorage(ApprovalDecisionInputSchema, approvalDecisionInput({ reason: 'x' })),
    ).toThrow(/only allowed when decision is/);
    expect(() =>
      toStorage(
        ApprovalDecisionInputSchema,
        approvalDecisionInput({ editedPayload: planReviewPayload() }),
      ),
    ).toThrow(/only allowed when decision is/);
  });

  it('edit: editedPayload is required and is validated against the payload schema', () => {
    expect(() =>
      toStorage(ApprovalDecisionInputSchema, approvalDecisionInput({ decision: 'edit' })),
    ).toThrow(/editedPayload/);
    const bad = { ...planReviewPayload(), checklist: [] };
    expect(() =>
      toStorage(
        ApprovalDecisionInputSchema,
        approvalDecisionInput({ decision: 'edit', editedPayload: bad }),
      ),
    ).toThrow();
    expect(() =>
      toStorage(
        ApprovalDecisionInputSchema,
        approvalDecisionInput({ decision: 'edit', editedPayload: planReviewPayload() }),
      ),
    ).not.toThrow();
  });

  it('reject: reason is required and may not be blank', () => {
    expect(() =>
      toStorage(ApprovalDecisionInputSchema, approvalDecisionInput({ decision: 'reject' })),
    ).toThrow(/reason/);
    expect(() =>
      toStorage(
        ApprovalDecisionInputSchema,
        approvalDecisionInput({ decision: 'reject', reason: '   ' }),
      ),
    ).toThrow();
    expect(() =>
      toStorage(
        ApprovalDecisionInputSchema,
        approvalDecisionInput({ decision: 'reject', reason: 'wrong venue' }),
      ),
    ).not.toThrow();
  });

  it('a decision is never a boolean and decidedBy is mandatory', () => {
    expect(() =>
      toStorage(ApprovalDecisionInputSchema, approvalDecisionInput({ decision: true as never })),
    ).toThrow();
    expect(() =>
      toStorage(ApprovalDecisionInputSchema, approvalDecisionInput({ decidedBy: '' })),
    ).toThrow();
  });
});

describe('DecisionValueSchema (what interrupt() resumes with)', () => {
  it('is a discriminated union of the three decisions', () => {
    expect(ok(DecisionValueSchema.safeParse({ decision: 'approve' }))).toBe(true);
    expect(
      ok(DecisionValueSchema.safeParse({ decision: 'edit', editedPayload: planReviewPayload() })),
    ).toBe(true);
    expect(ok(DecisionValueSchema.safeParse({ decision: 'reject', reason: 'no' }))).toBe(true);
  });
  it('refuses booleans, a reasonless reject, a payloadless edit and extra keys', () => {
    for (const bad of [
      true,
      false,
      { decision: 'reject' },
      { decision: 'edit' },
      { decision: 'approve', reason: 'x' },
      { decision: 'maybe' },
      'approve',
    ]) {
      expect(ok(DecisionValueSchema.safeParse(bad))).toBe(false);
    }
  });
});
