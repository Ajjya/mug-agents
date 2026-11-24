import type { MessageChannel } from '../../domain/message.schema.js';
import type { Speaker, SpeakerHandleKind } from '../../domain/speaker.schema.js';
import type { Decision, PlannedAction } from './decide.js';

/**
 * HOW a message reaches a speaker, decided AFTER decideActions has decided WHAT is due, never inside it.
 * The channel is not a property of a speaker but of the stage of the relationship: first contact is usually
 * a person on LinkedIn, and an address appears later, for some, when they reply. So it is read from what we
 * know about the speaker NOW, each time, and never stored as a preference.
 *
 *  - an address on file          -> `email`: a draft, as always;
 *  - no address, a handle        -> `manual:<handle>`: the SAME drafted text, stored with that channel, and a
 *                                   task so a person sends it by hand;
 *  - nothing at all              -> `no_contact`: no draft, one task to find contact details.
 */
export type Delivery = 'email' | `manual:${SpeakerHandleKind}` | 'no_contact';

/** First handle wins, in this order: LinkedIn is where first contact usually happens. */
const HANDLE_ORDER: readonly SpeakerHandleKind[] = ['linkedin', 'whatsapp', 'other'];

/** Pure. */
export function chooseDelivery(speaker: Pick<Speaker, 'emails' | 'handles'>): Delivery {
  if (speaker.emails.length > 0) return 'email';
  const handle = HANDLE_ORDER.find((h) => Boolean(speaker.handles[h]?.trim()));
  return handle ? `manual:${handle}` : 'no_contact';
}

/** The message channel a delivery stores; `no_contact` has none. */
export function channelOf(delivery: Delivery): MessageChannel | null {
  if (delivery === 'email') return 'email';
  return delivery === 'no_contact' ? null : (delivery.slice('manual:'.length) as MessageChannel);
}

export type RoutedAction = PlannedAction & { delivery: Exclude<Delivery, 'no_contact'> };

/** decideActions' decision with each action given a delivery; `no_contact` ones set aside for a task. */
export interface RoutedDecision extends Omit<Decision, 'actions' | 'deferred'> {
  actions: RoutedAction[];
  deferred: RoutedAction[];
  /** Due, but there is no way to reach the speaker at all: one task, no draft. */
  noContact: PlannedAction[];
}

/**
 * Routes a decision made with NO draft cap, then applies `maxDraftsPerRun` to what can actually be drafted,
 * so speakers nobody can reach never use up the cap and starve the ones who can be written to.
 */
export function routeDelivery(
  decision: Decision,
  speakers: readonly Pick<Speaker, '_id' | 'emails' | 'handles'>[],
  maxDraftsPerRun: number,
): RoutedDecision {
  const byId = new Map(speakers.map((s) => [s._id.toLowerCase(), s]));
  const draftable: RoutedAction[] = [];
  const noContact: PlannedAction[] = [];
  for (const a of [...decision.actions, ...decision.deferred]) {
    const s = byId.get(a.speakerId.toLowerCase());
    const delivery = s ? chooseDelivery(s) : 'no_contact';
    if (delivery === 'no_contact') noContact.push(a);
    else draftable.push({ ...a, delivery });
  }
  const notes = [...decision.notes];
  const deferred = draftable.slice(maxDraftsPerRun);
  if (deferred.length > 0) {
    notes.push(
      `${String(draftable.length)} messages are due; MAX_DRAFTS_PER_RUN is ${String(maxDraftsPerRun)}, so ${String(deferred.length)} wait for the next run.`,
    );
  }
  return {
    ...decision,
    notes,
    actions: draftable.slice(0, maxDraftsPerRun),
    deferred,
    noContact,
  };
}
