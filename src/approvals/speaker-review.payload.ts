import { z } from 'zod';
import { ENTITY_ID_RE } from '../domain/common.js';
import { MESSAGE_KINDS } from '../domain/message.schema.js';

const hexId = z.string().regex(ENTITY_ID_RE, 'must be a 24-character hex id');
const text = (max: number) => z.string().trim().min(1).max(max);

const ReviewDraftSchema = z
  .object({
    messageId: hexId,
    speakerId: hexId,
    /** The recipient, as a human reads it. Chosen by code, never by the model. */
    speakerName: text(200),
    kind: z.enum(MESSAGE_KINDS),
    round: z.number().int().min(1),
    reason: text(500),
    subject: text(300),
    body: text(8000),
  })
  .strict();

/**
 * The Speakers agent's interrupt payload: the drafts that need a human, with recipient, kind and
 * reason. Not the graph state. The same schema validates an edited payload.
 */
export const SpeakerReviewPayloadSchema = z
  .object({
    eventId: hexId,
    eventTitle: text(200),
    drafts: z.array(ReviewDraftSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.drafts.forEach((d, i) => {
      if (seen.has(d.messageId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['drafts', i, 'messageId'],
          message: 'each draft at most once',
        });
      }
      seen.add(d.messageId);
    });
  });

export type SpeakerReviewPayload = z.infer<typeof SpeakerReviewPayloadSchema>;

export class InvalidSpeakerEditError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`The edited drafts are not acceptable:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'InvalidSpeakerEditError';
  }
}

/**
 * An edit of speaker drafts can only REMOVE drafts: the kept ones are approved, the removed ones are
 * rejected. Nothing in a kept draft may change: its facts were filled from the event record, and its
 * recipient was chosen by code. Wording is changed by a NEW round, never by editing a stored draft:
 * remove (or reject) the draft here, then `speakers run --event <id> --redraft <kind> --speaker <id>`.
 */
export function assertSpeakerEditAllowed(
  original: SpeakerReviewPayload,
  edited: SpeakerReviewPayload,
): void {
  const problems: string[] = [];
  if (edited.eventId.toLowerCase() !== original.eventId.toLowerCase())
    problems.push('eventId cannot be changed');
  if (edited.eventTitle !== original.eventTitle) problems.push('eventTitle cannot be changed');
  const byId = new Map(original.drafts.map((d) => [d.messageId.toLowerCase(), d]));
  for (const d of edited.drafts) {
    const o = byId.get(d.messageId.toLowerCase());
    if (!o) {
      problems.push(`draft ${d.messageId} was not in the request: an edit can only remove drafts`);
      continue;
    }
    if (JSON.stringify(o) !== JSON.stringify({ ...o, ...d })) {
      problems.push(
        `draft ${d.messageId} was changed: an edit can only remove drafts. To reword it, remove it here (or reject the request), then run: ` +
          `npm run speakers -- run --event ${original.eventId} --redraft ${o.kind} --speaker ${o.speakerId}`,
      );
    }
  }
  if (problems.length > 0) throw new InvalidSpeakerEditError(problems);
}

/** Which drafts an edited payload keeps (approved) and drops (rejected). */
export function splitEdit(
  original: SpeakerReviewPayload,
  edited: SpeakerReviewPayload,
): { kept: string[]; removed: string[] } {
  const keep = new Set(edited.drafts.map((d) => d.messageId.toLowerCase()));
  const ids = original.drafts.map((d) => d.messageId.toLowerCase());
  return { kept: ids.filter((id) => keep.has(id)), removed: ids.filter((id) => !keep.has(id)) };
}
