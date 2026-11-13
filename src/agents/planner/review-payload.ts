import {
  PlanReviewPayloadSchema,
  type PlanReviewPayload,
} from '../../approvals/plan-review.payload.js';
import type { ChecklistOutput, TimelineOutput } from './llm-schemas.js';
import type { Milestone } from './timeline.js';

export interface ReviewInputs {
  eventId: string;
  theme: string;
  milestones: readonly Milestone[];
  timeline: TimelineOutput;
  checklist: ChecklistOutput;
}

/**
 * Builds the interrupt payload: the computed timeline (dates from code, goals from the model) and the
 * proposed checklist. Nothing else leaves the graph for a human: no state, prompts or model metadata.
 * Parsed through the contract so what is shown is guaranteed to be what a decision is validated against.
 */
export function buildPlanReviewPayload(input: ReviewInputs): PlanReviewPayload {
  const goals = new Map(input.timeline.milestones.map((m) => [m.key, m]));
  return PlanReviewPayloadSchema.parse({
    eventId: input.eventId,
    theme: input.theme,
    milestones: input.milestones.map((m) => {
      const g = goals.get(m.key);
      return {
        key: m.key,
        label: m.label,
        dateIso: m.dateIso,
        clamped: m.clamped,
        goal: g?.goal ?? '',
        work: g?.work ?? [],
      };
    }),
    checklist: input.checklist.tasks.map((t) => ({
      milestone: t.milestone,
      title: t.title,
      owner: t.owner,
    })),
  });
}
