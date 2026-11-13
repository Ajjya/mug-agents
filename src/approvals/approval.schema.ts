import { z } from 'zod';
import { documentShape, entityId, isoDate, nonEmpty } from '../domain/common.js';
import { PlanReviewPayloadSchema } from './plan-review.payload.js';

export const APPROVAL_KINDS = ['plan_review'] as const;
export const APPROVAL_REQUEST_STATUSES = ['pending', 'decided', 'expired'] as const;
export const APPROVAL_DECISIONS = ['approve', 'edit', 'reject'] as const;

// --- ApprovalRequest -------------------------------------------------------------------------

export const ApprovalRequestInputSchema = z
  .object({
    threadId: nonEmpty,
    /** One planning run of a thread. With nodeName it makes a request unique: re-running a node
     *  after a resume finds its request instead of creating a second one. */
    runId: nonEmpty,
    nodeName: nonEmpty,
    eventId: entityId,
    kind: z.enum(APPROVAL_KINDS),
    payload: PlanReviewPayloadSchema,
    status: z.enum(APPROVAL_REQUEST_STATUSES),
    decidedAt: isoDate.optional(),
  })
  .strict();

export const ApprovalRequestSchema = ApprovalRequestInputSchema.extend(documentShape);
/** Only the lifecycle changes after creation; the payload that was shown is immutable. */
export const ApprovalRequestPatchSchema = z
  .object({ status: z.enum(APPROVAL_REQUEST_STATUSES), decidedAt: isoDate })
  .partial()
  .strict();

export type ApprovalRequestInput = z.infer<typeof ApprovalRequestInputSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalRequestPatch = z.infer<typeof ApprovalRequestPatchSchema>;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

// --- ApprovalDecision ------------------------------------------------------------------------

/** What a human sends back (and what interrupt() resumes with): a decision, never a boolean. */
export const DecisionValueSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('edit'), editedPayload: PlanReviewPayloadSchema }).strict(),
  z.object({ decision: z.literal('reject'), reason: nonEmpty }).strict(),
]);
export type DecisionValue = z.infer<typeof DecisionValueSchema>;

const decisionBase = z
  .object({
    requestId: entityId,
    decision: z.enum(APPROVAL_DECISIONS),
    editedPayload: PlanReviewPayloadSchema.optional(),
    reason: nonEmpty.optional(),
    /** Whoever the CLI/config says. No authentication yet: recorded as given. */
    decidedBy: nonEmpty,
    decidedAt: isoDate,
  })
  .strict();

type DecisionShape = z.infer<typeof decisionBase>;

/** edit needs the corrected payload, reject needs a reason, approve carries neither. */
function decisionRules(value: DecisionShape, ctx: z.RefinementCtx): void {
  const hasEdit = value.editedPayload !== undefined;
  const hasReason = value.reason !== undefined;
  if (value.decision === 'edit' && !hasEdit) {
    ctx.addIssue({
      code: 'custom',
      path: ['editedPayload'],
      message: 'required when decision is "edit"',
    });
  }
  if (value.decision === 'reject' && !hasReason) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: 'required when decision is "reject"',
    });
  }
  if (value.decision !== 'edit' && hasEdit) {
    ctx.addIssue({
      code: 'custom',
      path: ['editedPayload'],
      message: 'only allowed when decision is "edit"',
    });
  }
  if (value.decision !== 'reject' && hasReason) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: 'only allowed when decision is "reject"',
    });
  }
}

export const ApprovalDecisionInputSchema = decisionBase.superRefine(decisionRules);
export const ApprovalDecisionSchema = decisionBase.extend(documentShape).superRefine(decisionRules);
/** Decisions are an audit record: nothing in one is ever patched. */
export const ApprovalDecisionPatchSchema = z.object({ reason: nonEmpty }).partial().strict();

export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInputSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ApprovalDecisionPatch = z.infer<typeof ApprovalDecisionPatchSchema>;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number];
