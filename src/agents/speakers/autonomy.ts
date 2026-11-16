import { type AutonomyAction, requireAutonomy } from '../../approvals/autonomy.js';
import { type MessageKind, isChaseKind } from '../../domain/message.schema.js';

/**
 * Which row of the autonomy table a drafted speaker message falls under. Pure: the only inputs are
 * the kind and whether the speaker has ever had a message marked sent (for any event).
 *
 *  - no sent message ever                    -> first_contact_message, whatever the kind
 *  - invitation to someone already contacted -> draft_speaker_message
 *  - a chase in an existing thread           -> chase_in_existing_thread
 *  - thank-you                               -> thank_you_message
 */
export function messageAutonomyAction(kind: MessageKind, hasPriorSent: boolean): AutonomyAction {
  if (!hasPriorSent) return 'first_contact_message';
  if (kind === 'thank_you') return 'thank_you_message';
  if (isChaseKind(kind)) return 'chase_in_existing_thread';
  return 'draft_speaker_message';
}

/** True when a human must approve the draft before it counts as "send this now". */
export function needsApproval(kind: MessageKind, hasPriorSent: boolean): boolean {
  return requireAutonomy(messageAutonomyAction(kind, hasPriorSent)) === 'approve';
}
