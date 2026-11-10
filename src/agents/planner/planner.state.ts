import { registry } from '@langchain/langgraph/zod';
import { z } from 'zod';
import { ENTITY_ID_RE } from '../../domain/common.js';
import type { LlmCallRecord } from '../../llm/model.types.js';
import { MILESTONE_KEYS } from './timeline.js';
import { ChecklistOutputSchema, TimelineOutputSchema } from './llm-schemas.js';

export const BRIEF_FORMATS = ['talks', 'workshop', 'lightning'] as const;

/** `YYYY-MM-DD` or a full ISO-8601 instant. Date-only means UTC midnight. */
const briefDate = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}(T.+)?$/.test(v) && !Number.isNaN(new Date(v).getTime()), {
    message: 'must be an ISO-8601 date (YYYY-MM-DD) or datetime',
  })
  .transform((v) => (v.length === 10 ? `${v}T00:00:00.000Z` : new Date(v).toISOString()));

/** The input to the planning flow. */
export const EventBriefSchema = z
  .object({
    theme: z.string().trim().min(1).max(200),
    date: briefDate,
    format: z.enum(BRIEF_FORMATS),
    capacity: z.number().int().positive(),
    coHost: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(4000).optional(),
    /** Plan an existing event (otherwise matched on theme + date, or created). */
    eventId: z.string().regex(ENTITY_ID_RE, 'must be a 24-character hex id').optional(),
  })
  .strict();
export type EventBrief = z.infer<typeof EventBriefSchema>;

const MilestoneSchema = z.object({
  key: z.enum(MILESTONE_KEYS),
  label: z.string(),
  dateIso: z.string(),
  clamped: z.boolean(),
});

const concat = <T>(a: T[], b: T[]): T[] => a.concat(b);

/** Graph state (LangGraph). `calls` accumulates across nodes via its reducer. */
export const PlannerStateSchema = z.object({
  // z.custom, not EventBriefSchema: LangGraph derives node update types from schema *inputs*, and the
  // brief is validated explicitly in the normaliseBrief node anyway.
  brief: z.custom<EventBrief>().optional(),
  /** Injected "today", so runs (and tests) are reproducible. */
  nowIso: z.string().optional(),
  /** Ladder index the model nodes start at (default 0). */
  startAt: z.number().int().min(0).optional(),
  milestones: z.array(MilestoneSchema).optional(),
  timeline: TimelineOutputSchema.optional(),
  checklist: ChecklistOutputSchema.optional(),
  calls: z
    .custom<LlmCallRecord[]>()
    .default(() => [])
    .register(registry, { reducer: { fn: concat }, default: () => [] }),
});

export type PlannerState = z.infer<typeof PlannerStateSchema>;
