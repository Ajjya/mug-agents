import type { SpeakerReviewPayload } from '../../src/approvals/speaker-review.payload.js';
import type {
  ApprovalDecisionInput,
  ApprovalRequestInput,
} from '../../src/approvals/approval.schema.js';
import type { PlanReviewPayload } from '../../src/approvals/plan-review.payload.js';
import { buildPlanReviewPayload } from '../../src/agents/planner/review-payload.js';
import { ID_A } from './fixtures.js';
import { NOW, brief, checklistOutput, draft, timelineOutput } from './planner-fixtures.js';

export const planReviewPayload = (eventId: string = ID_A): PlanReviewPayload => {
  const d = draft(brief(), { timeline: timelineOutput(), checklist: checklistOutput() });
  return buildPlanReviewPayload({
    eventId,
    theme: d.brief.theme,
    milestones: d.milestones,
    timeline: d.timeline,
    checklist: d.checklist,
  });
};

export const approvalRequestInput = (
  over: Partial<ApprovalRequestInput> = {},
): ApprovalRequestInput => ({
  threadId: `event:${ID_A}:plan`,
  runId: 'run-1',
  nodeName: 'requestPlanApproval',
  eventId: ID_A,
  kind: 'plan_review',
  payload: planReviewPayload(),
  status: 'pending',
  ...over,
});

export const approvalDecisionInput = (
  over: Partial<ApprovalDecisionInput> = {},
): ApprovalDecisionInput => ({
  requestId: ID_A,
  decision: 'approve',
  decidedBy: 'vlad',
  decidedAt: NOW.toISOString(),
  ...over,
});

export const speakerReviewPayload = (eventId: string = ID_A): SpeakerReviewPayload => ({
  eventId,
  eventTitle: 'MUG Sample City Winter Meetup',
  drafts: [
    {
      messageId: 'c'.repeat(24),
      speakerId: 'd'.repeat(24),
      speakerName: 'Wendeline Gooseberry',
      kind: 'invitation',
      round: 1,
      reason: 'status idea and T-6w reached (2026-10-31)',
      subject: 'Would you speak at MUG Sample City Winter Meetup?',
      body: 'Hello Wendeline,\nWould you speak at MUG Sample City Winter Meetup on Saturday 12 December 2026?',
    },
    {
      messageId: 'e'.repeat(24),
      speakerId: 'f'.repeat(24),
      speakerName: 'Ignatius Fogwhistle',
      kind: 'invitation',
      round: 1,
      reason: 'status idea and T-6w reached (2026-10-31)',
      subject: 'Would you speak at MUG Sample City Winter Meetup?',
      body: 'Hello Ignatius,\nWould you speak at MUG Sample City Winter Meetup on Saturday 12 December 2026?',
    },
  ],
});
