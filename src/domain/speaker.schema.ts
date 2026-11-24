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

/**
 * How to reach a speaker where email does not (yet) apply. First contact is usually a person on LinkedIn;
 * an address appears later, for some, when they reply. A speaker with handles and no email is the normal
 * first state, not an error.
 */
export const SPEAKER_HANDLE_KINDS = ['linkedin', 'whatsapp', 'other'] as const;
export type SpeakerHandleKind = (typeof SPEAKER_HANDLE_KINDS)[number];
export const SpeakerHandlesSchema = z
  .object({
    linkedin: nonEmpty.optional(),
    whatsapp: nonEmpty.optional(),
    other: nonEmpty.optional(),
  })
  .strict();

/**
 * Where a speaker can be READ about, never how to REACH them: `handles` owns everything used to reach a
 * person (LinkedIn included). A LinkedIn URL has exactly one home, `handles.linkedin`.
 */
export const SpeakerLinksSchema = z
  .object({
    github: z.url().optional(),
    website: z.url().optional(),
  })
  .strict();

export const SpeakerEventStatusSchema = z
  .object({
    eventId: entityId,
    status: z.enum(SPEAKER_STATUSES),
    updatedAt: isoDate,
    /**
     * When mail from this speaker last arrived and was linked to this event (set by the inbox, never by
     * the Speakers agent). Any inbound message counts, classified or not: it pauses chasing until a
     * human acts. Independent of `updatedAt`, which dates the STATUS.
     */
    lastInboundAt: isoDate.optional(),
  })
  .strict();

/** Stable, database-independent key (e.g. `ana-ferreira`): what a seed file and a corpus manifest use. */
export const SPEAKER_HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SpeakerInputSchema = z
  .object({
    name: nonEmpty,
    /**
     * How the speaker likes to be addressed, entered by a human. Used in greetings when present, else
     * the full name. Never derived: no code splits or shortens `name`, because names do not divide
     * into first and last the same way across cultures.
     */
    preferredName: nonEmpty.optional(),
    handle: z
      .string()
      .regex(SPEAKER_HANDLE_RE, 'must be a lower-case slug like "ana-ferreira"')
      .optional(),
    /**
     * Every address this person writes from: may be empty, lower-cased (so the unique index is effectively
     * case-insensitive), unique across speakers. Added by a human (`inbox link --adopt-address`), never
     * guessed and never written by an agent.
     */
    emails: z
      .array(z.email().toLowerCase())
      .refine((a) => new Set(a).size === a.length, 'must not repeat an address'),
    handles: SpeakerHandlesSchema,
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
