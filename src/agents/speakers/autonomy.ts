import { type AutonomyAction, requireAutonomy } from '../../approvals/autonomy.js';
import { type DraftKind, isChaseKind } from '../../domain/message.schema.js';

/**
 * Which row of the autonomy table a drafted speaker message falls under. Pure.
 *
 * There is no first-contact row: the agent never writes the first message to a speaker, and no code path
 * can (decideActions, then the store, both refuse a speaker with no sent message). Everything it drafts is
 * therefore a reply in a conversation that already exists.
 *
 *  - a chase in an existing thread -> chase_in_existing_thread
 *  - thank-you                     -> thank_you_message
 */
export function messageAutonomyAction(kind: DraftKind): AutonomyAction {
  if (kind === 'thank_you') return 'thank_you_message';
  if (isChaseKind(kind)) return 'chase_in_existing_thread';
  return 'draft_speaker_message';
}

/** True when a human must approve the draft before it counts as "send this now". */
export function needsApproval(kind: DraftKind): boolean {
  return requireAutonomy(messageAutonomyAction(kind)) === 'approve';
}
