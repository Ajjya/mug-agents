import { z } from 'zod';
import { documentShape, entityId, isoDate, nonEmpty } from './common.js';

export const SPEAKER_STATUSES = [
  'idea',
  'invited',
  'confirmed',
  'abstract_received',
  'slides_received',
  'thanked',
  'declined',
] as const;

export const SpeakerLinksSchema = z
  .object({
    linkedin: z.url().optional(),
    github: z.url().optional(),
    website: z.url().optional(),
  })
  .strict();

export const SpeakerEventStatusSchema = z
  .object({
    eventId: entityId,
    status: z.enum(SPEAKER_STATUSES),
    updatedAt: isoDate,
  })
  .strict();

/** Stable, database-independent key (e.g. `ana-ferreira`): what a seed file and a corpus manifest use. */
export const SPEAKER_HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SpeakerInputSchema = z
  .object({
    name: nonEmpty,
    handle: z
      .string()
      .regex(SPEAKER_HANDLE_RE, 'must be a lower-case slug like "ana-ferreira"')
      .optional(),
    // Lower-cased so the unique index on email is effectively case-insensitive.
    email: z.email().toLowerCase().optional(),
    topics: z.array(nonEmpty),
    bio: z.string().optional(),
    photoUrl: z.url().optional(),
    links: SpeakerLinksSchema,
    perEvent: z.array(SpeakerEventStatusSchema),
  })
  .strict();

export const SpeakerSchema = SpeakerInputSchema.extend(documentShape);
export const SpeakerPatchSchema = SpeakerInputSchema.partial();

export type SpeakerStatus = (typeof SPEAKER_STATUSES)[number];
export type SpeakerInput = z.infer<typeof SpeakerInputSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;
export type SpeakerPatch = z.infer<typeof SpeakerPatchSchema>;
