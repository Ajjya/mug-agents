import { describe, expect, it } from 'vitest';
import {
  ApprovalPayloadSchema,
  ApprovalRequestInputSchema,
  DecisionValueSchema,
  payloadKind,
} from '../../src/approvals/approval.schema.js';
import { assertEditMatches } from '../../src/approvals/approvals.service.js';
import { formatRequest, formatThreadOutcome } from '../../src/approvals/format.js';
import { InvalidEditError } from '../../src/approvals/plan-review.payload.js';
import {
  InvalidSpeakerEditError,
  SpeakerReviewPayloadSchema,
  splitEdit,
} from '../../src/approvals/speaker-review.payload.js';
import { toStorage } from '../../src/domain/common.js';
import { ID_A } from '../support/fixtures.js';
import {
  approvalRequestInput,
  planReviewPayload,
  speakerReviewPayload,
} from '../support/approval-fixtures.js';

describe('speaker review payload', () => {
  it('parses, and a payload is exactly one kind', () => {
    const p = speakerReviewPayload();
    expect(SpeakerReviewPayloadSchema.parse(p)).toEqual(p);
    expect(payloadKind(ApprovalPayloadSchema.parse(p))).toBe('speaker_messages');
    expect(payloadKind(ApprovalPayloadSchema.parse(planReviewPayload()))).toBe('plan_review');
    expect(() => ApprovalPayloadSchema.parse({ ...p, theme: 'x' })).toThrow();
  });

  it('rejects an empty draft list and a duplicated draft', () => {
    const p = speakerReviewPayload();
    expect(SpeakerReviewPayloadSchema.safeParse({ ...p, drafts: [] }).success).toBe(false);
    const first = p.drafts[0];
    expect(first).toBeDefined();
    expect(SpeakerReviewPayloadSchema.safeParse({ ...p, drafts: [first, first] }).success).toBe(
      false,
    );
  });

  it('an approval request and an edit decision accept it', () => {
    const payload = speakerReviewPayload();
    expect(() =>
      toStorage(
        ApprovalRequestInputSchema,
        approvalRequestInput({
          kind: 'speaker_messages',
          threadId: `event:${ID_A}:speakers`,
          nodeName: 'requestApproval',
          payload,
        }),
      ),
    ).not.toThrow();
    expect(
      DecisionValueSchema.safeParse({ decision: 'edit', editedPayload: payload }).success,
    ).toBe(true);
  });
});

describe('editing speaker drafts: removal only', () => {
  const original = speakerReviewPayload();
  const [first, second] = original.drafts;
  if (!first || !second) throw new Error('fixture needs two drafts');

  it('removing a draft is allowed, and splits kept from removed', () => {
    const edited = { ...original, drafts: [first] };
    expect(() => {
      assertEditMatches(original, edited);
    }).not.toThrow();
    expect(splitEdit(original, edited)).toEqual({
      kept: [first.messageId],
      removed: [second.messageId],
    });
  });

  it('changing a kept draft is refused: body, recipient or kind', () => {
    for (const change of [
      { body: 'Rewritten, with a new date: 1 January.' },
      { speakerId: '9'.repeat(24) },
      { kind: 'thank_you' as const },
    ]) {
      expect(() => {
        assertEditMatches(original, { ...original, drafts: [{ ...first, ...change }] });
      }).toThrow(InvalidSpeakerEditError);
    }
  });

  it('adding a draft that was not in the request is refused', () => {
    const extra = { ...first, messageId: '7'.repeat(24) };
    expect(() => {
      assertEditMatches(original, { ...original, drafts: [first, extra] });
    }).toThrow(/only remove drafts/);
  });

  it('an edit of the wrong kind is refused, both ways', () => {
    expect(() => {
      assertEditMatches(original, planReviewPayload());
    }).toThrow(InvalidEditError);
    expect(() => {
      assertEditMatches(planReviewPayload(), original);
    }).toThrow(InvalidEditError);
  });
});

describe('formatting speaker approvals', () => {
  const stamp = {
    _id: 'f'.repeat(24),
    version: 1,
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
  };
  it('shows recipient, kind, reason and the text', () => {
    const text = formatRequest(
      {
        ...approvalRequestInput({
          kind: 'speaker_messages',
          threadId: `event:${ID_A}:speakers`,
          payload: speakerReviewPayload(),
        }),
        ...stamp,
      },
      { threadId: `event:${ID_A}:speakers`, status: 'awaiting_decision', next: [], calls: [] },
      null,
    );
    expect(text).toContain('to Wendeline Gooseberry');
    expect(text).toContain('invitation round 1');
    expect(text).toContain('why: status idea and T-6w reached');
    expect(text).toContain('Would you speak at');
  });

  it('describes a finished speakers run in its own terms', () => {
    const out = formatThreadOutcome({
      threadId: `event:${ID_A}:speakers`,
      status: 'completed',
      next: [],
      calls: [],
      outcome: 'persisted',
      persisted: { created: 2, skipped: 1 },
    });
    expect(out).toContain('2 approved, 1 rejected');
  });
});
