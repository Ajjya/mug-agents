import { z } from 'zod';
import { OWNER_ROLES } from '../agents/planner/llm-schemas.js';
import { MILESTONE_KEYS } from '../agents/planner/timeline.js';
import { ENTITY_ID_RE } from '../domain/common.js';

const text = (max: number) => z.string().trim().min(1).max(max);

const normaliseTitle = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, ' ');

const ReviewMilestoneSchema = z
  .object({
    key: z.enum(MILESTONE_KEYS),
    label: z.string().min(1),
    /** Computed in code. Shown to the human; not editable. */
    dateIso: z.string().min(1),
    clamped: z.boolean(),
    goal: text(200),
    work: z.array(text(200)).min(1).max(8),
  })
  .strict();

const ReviewTaskSchema = z
  .object({
    milestone: z.enum(MILESTONE_KEYS),
    title: text(140),
    owner: z.enum(OWNER_ROLES),
  })
  .strict();

/**
 * The interrupt payload: a typed contract carrying exactly what a human needs to review a plan,
 * the computed timeline and the proposed checklist. No graph state, no prompts, no model metadata.
 * The same schema validates an edited payload before the graph is resumed.
 */
export const PlanReviewPayloadSchema = z
  .object({
    eventId: z.string().regex(ENTITY_ID_RE, 'must be a 24-character hex id'),
    theme: text(200),
    milestones: z.array(ReviewMilestoneSchema),
    checklist: z.array(ReviewTaskSchema).min(1).max(80),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.milestones.map((m) => m.key);
    if (keys.join('|') !== MILESTONE_KEYS.join('|')) {
      ctx.addIssue({
        code: 'custom',
        path: ['milestones'],
        message: `must contain exactly these keys, once each, in this order: ${MILESTONE_KEYS.join(', ')}`,
      });
    }
    const seen = new Set<string>();
    value.checklist.forEach((task, i) => {
      const key = `${task.milestone}|${normaliseTitle(task.title)}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checklist', i, 'title'],
          message: `duplicate title within milestone ${task.milestone}`,
        });
      }
      seen.add(key);
    });
  });

export type PlanReviewPayload = z.infer<typeof PlanReviewPayloadSchema>;

export class InvalidEditError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`The edited plan is not acceptable:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'InvalidEditError';
  }
}

/**
 * An edit may change goals, work items and the checklist. It may not change what code computed:
 * the event, the theme, or any milestone's key, label, date or clamped flag. Dates in particular
 * are never taken from a human-edited or model-written payload.
 */
export function assertEditAllowed(original: PlanReviewPayload, edited: PlanReviewPayload): void {
  const problems: string[] = [];
  if (edited.eventId.toLowerCase() !== original.eventId.toLowerCase())
    problems.push('eventId cannot be changed');
  if (edited.theme !== original.theme) problems.push('theme cannot be changed');
  original.milestones.forEach((m, i) => {
    const e = edited.milestones[i];
    if (!e) return;
    if (
      e.key !== m.key ||
      e.label !== m.label ||
      e.dateIso !== m.dateIso ||
      e.clamped !== m.clamped
    ) {
      problems.push(
        `milestone ${m.key}: key, label and date are computed in code and cannot be edited`,
      );
    }
  });
  if (problems.length > 0) throw new InvalidEditError(problems);
}
