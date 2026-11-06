import { z } from 'zod';
import { documentShape, entityId, isoDate, nonEmpty } from './common.js';

export const EVENT_PHASES = [
  'idea',
  'planning',
  'venue_confirmed',
  'published',
  'done',
  'cancelled',
] as const;

export const AgendaItemSchema = z
  .object({
    speakerId: entityId.optional(),
    title: nonEmpty,
    startsAt: isoDate.optional(),
    durationMin: z.number().int().positive().optional(),
  })
  .strict();

export const EventInputSchema = z
  .object({
    title: nonEmpty,
    theme: nonEmpty.optional(),
    phase: z.enum(EVENT_PHASES),
    date: isoDate.optional(),
    venueOrganisationId: entityId.optional(),
    coHostOrganisationIds: z.array(entityId),
    capacity: z.number().int().positive().optional(),
    meetupUrl: z.url().optional(),
    agenda: z.array(AgendaItemSchema),
    notes: z.string().optional(),
  })
  .strict();

export const EventSchema = EventInputSchema.extend(documentShape);
export const EventPatchSchema = EventInputSchema.partial();

export type EventPhase = (typeof EVENT_PHASES)[number];
export type AgendaItem = z.infer<typeof AgendaItemSchema>;
export type EventInput = z.infer<typeof EventInputSchema>;
export type Event = z.infer<typeof EventSchema>;
export type EventPatch = z.infer<typeof EventPatchSchema>;
