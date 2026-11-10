import { z } from 'zod';
import { MILESTONE_KEYS } from './timeline.js';

/**
 * What the model is asked to return. Deliberately separate from the domain schemas: no `_id`, no
 * `version`, no timestamps, no dates of any kind (dates are computed in code), plain enums only.
 * Every object is strict, so an invented `id` (or any other unknown key) fails validation.
 */
export const OWNER_ROLES = [
  'organiser',
  'speaker-liaison',
  'venue-lead',
  'marketing',
  'co-host',
  'volunteer',
] as const;
export type OwnerRole = (typeof OWNER_ROLES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

const TimelineMilestoneSchema = z
  .object({
    key: z.enum(MILESTONE_KEYS),
    goal: text(200),
    work: z.array(text(200)).min(1).max(8),
  })
  .strict();

/** One entry per milestone, in chronological order: that is fixed by the code-computed timeline. */
export const TimelineOutputSchema = z
  .object({ milestones: z.array(TimelineMilestoneSchema) })
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
  });
export type TimelineOutput = z.infer<typeof TimelineOutputSchema>;

const ChecklistItemSchema = z
  .object({
    milestone: z.enum(MILESTONE_KEYS),
    title: text(140),
    owner: z.enum(OWNER_ROLES),
  })
  .strict();

export const normaliseTitle = (title: string): string =>
  title.trim().toLowerCase().replace(/\s+/g, ' ');

export const ChecklistOutputSchema = z
  .object({ tasks: z.array(ChecklistItemSchema).min(1).max(80) })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.tasks.forEach((task, i) => {
      const key = `${task.milestone}|${normaliseTitle(task.title)}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', i, 'title'],
          message: `duplicate title within milestone ${task.milestone}`,
        });
      }
      seen.add(key);
    });
  });
export type ChecklistOutput = z.infer<typeof ChecklistOutputSchema>;
