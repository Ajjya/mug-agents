import { z } from 'zod';
import { documentShape, entityId, isoDate, nonEmpty } from './common.js';

/**
 * What a speaker message is for. `chase_reply` is not in the M3b spec's list: an `invited` speaker who
 * has not answered is chased for a reply, and giving that its own kind keeps its rounds apart from the
 * abstract chases a confirmed speaker gets (CHASE_MAX_ROUNDS counts per kind).
 */
export const MESSAGE_KINDS = [
  'invitation',
  'chase_reply',
  'chase_abstract',
  'chase_bio',
  'chase_photo',
  'chase_slides',
  'thank_you',
] as const;

export const CHASE_KINDS = [
  'chase_reply',
  'chase_abstract',
  'chase_bio',
  'chase_photo',
  'chase_slides',
] as const satisfies readonly (typeof MESSAGE_KINDS)[number][];

export const MESSAGE_CHANNELS = ['email'] as const;

/**
 *  - draft:      written, not reviewed (or reviewed and not needing approval)
 *  - approved:   a human approved it: "send this now"
 *  - rejected:   a human rejected it at review (with `rejectedAt`); it stays on record, and that kind
 *                waits for a human act: a status reset after `rejectedAt`, or `speakers run --redraft`
 *  - sent:       a human said it went out (`speakers sent <id>`); chases are measured from `sentAt`
 *  - superseded: no longer applies (the speaker's status moved on before it was sent)
 */
export const MESSAGE_STATUSES = ['draft', 'approved', 'rejected', 'sent', 'superseded'] as const;

/**
 * Commitments the code fills in. The model never writes these values: it writes `{{slot}}`
 * placeholders, and code substitutes the values from the event record after it answers.
 */
export const FACT_SLOTS = [
  'speaker_name',
  'event_title',
  'event_date',
  'event_time',
  'venue',
  'talk_slot',
  'due_date',
] as const;

export const MessageFactsSchema = z.partialRecord(z.enum(FACT_SLOTS), nonEmpty);

const messageBase = z
  .object({
    eventId: entityId,
    /** The recipient. Chosen by code from the pipeline, never by the model. */
    speakerId: entityId,
    kind: z.enum(MESSAGE_KINDS),
    channel: z.enum(MESSAGE_CHANNELS),
    /** 1-based: which attempt of this kind for this speaker and event. */
    round: z.number().int().min(1),
    subject: nonEmpty,
    /** Empty only for a send recorded outside the system (see {@link RECORDED_PREFIX}). */
    body: z.string(),
    /** The fact values substituted into subject/body, as taken from the event record. */
    facts: MessageFactsSchema,
    /** Why the agent planned it (from decideActions). */
    reason: nonEmpty,
    /** The autonomy table said a human must approve it before it is sent. */
    needsApproval: z.boolean(),
    status: z.enum(MESSAGE_STATUSES),
    rejectionReason: nonEmpty.optional(),
    /** When the rejection was decided: the approval decision's own timestamp. */
    rejectedAt: isoDate.optional(),
    approvalRequestId: entityId.optional(),
    /** `eventId:speakerId:kind:round`, unique: a second draft for the same key is a no-op. */
    idempotencyKey: nonEmpty,
    sentAt: isoDate.optional(),
    sentBy: nonEmpty.optional(),
  })
  .strict();

/**
 * A send a human did outside this system and recorded afterwards (`speakers sent --speaker ...`).
 * It has no text, and `sentBy` is `recorded:<name>`: that prefix is the marker, in one place.
 */
export const RECORDED_PREFIX = 'recorded:';
export const recordedBy = (name: string): string => `${RECORDED_PREFIX}${name}`;
export const isRecordedOutside = (m: { sentBy?: string | undefined }): boolean =>
  m.sentBy?.startsWith(RECORDED_PREFIX) === true;

/** A body may be empty only for a recorded send, which is always `sent` and marked by `sentBy`. */
function bodyRules(
  value: { body: string; status: string; sentBy?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.body.trim() !== '') return;
  if (value.status === 'sent' && isRecordedOutside(value)) return;
  ctx.addIssue({
    code: 'custom',
    path: ['body'],
    message: `must not be empty (only a send recorded outside the system, sentBy "${RECORDED_PREFIX}…", has no text)`,
  });
}

export const MessageInputSchema = messageBase.superRefine(bodyRules);
export const MessageSchema = messageBase.extend(documentShape).superRefine(bodyRules);

/** Only the lifecycle changes after creation: what was written (and reviewed) is immutable. */
export const MessagePatchSchema = messageBase
  .pick({
    status: true,
    rejectionReason: true,
    rejectedAt: true,
    approvalRequestId: true,
    sentAt: true,
    sentBy: true,
  })
  .partial()
  .strict();

export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type ChaseKind = (typeof CHASE_KINDS)[number];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type FactSlot = (typeof FACT_SLOTS)[number];
export type MessageFacts = z.infer<typeof MessageFactsSchema>;
export type MessageInput = z.infer<typeof MessageInputSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessagePatch = z.infer<typeof MessagePatchSchema>;

export const isChaseKind = (kind: MessageKind): kind is ChaseKind =>
  (CHASE_KINDS as readonly string[]).includes(kind);

/** The natural key `(eventId, speakerId, kind, round)` as one string, case-normalised. */
export function messageIdempotencyKey(
  eventId: string,
  speakerId: string,
  kind: MessageKind,
  round: number,
): string {
  if (!Number.isInteger(round) || round < 1) {
    throw new RangeError(`round must be an integer >= 1, got ${String(round)}`);
  }
  return `${eventId.toLowerCase()}:${speakerId.toLowerCase()}:${kind}:${String(round)}`;
}
