import { z } from 'zod';
import { documentShape, entityId, isoDate, nonEmpty } from './common.js';

export const TASK_STATUSES = ['open', 'doing', 'done', 'cancelled'] as const;
export const TASK_SOURCES = ['manual', 'agent'] as const;

export const TaskInputSchema = z
  .object({
    title: nonEmpty,
    owner: nonEmpty,
    dueAt: isoDate.optional(),
    status: z.enum(TASK_STATUSES),
    source: z.enum(TASK_SOURCES),
    relatedEventId: entityId.optional(),
    relatedSpeakerId: entityId.optional(),
    /** Which planner milestone (e.g. 'T-4w') the task belongs to. Part of the idempotency key. */
    milestoneKey: nonEmpty.optional(),
  })
  .strict();

export const TaskSchema = TaskInputSchema.extend(documentShape);
/** `source` records who created the task and is immutable. */
export const TaskPatchSchema = TaskInputSchema.omit({ source: true }).partial();

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskSource = (typeof TASK_SOURCES)[number];
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskPatch = z.infer<typeof TaskPatchSchema>;
