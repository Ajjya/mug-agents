import type { MessageChannel } from '../../domain/message.schema.js';
import type { Event } from '../../domain/event.schema.js';
import type { Speaker, SpeakerHandleKind } from '../../domain/speaker.schema.js';
import type { Decision, PlannedAction } from './decide.js';

/**
 * HOW a message reaches a speaker, decided AFTER decideActions has decided WHAT is due, never inside it.
 *
 * Read from what we know about the speaker NOW, each time, and never stored as a preference: an address
 * first, then a handle. There is no stage-dependent case left to reason about: the agent never writes the
 * first message (you do, by hand, wherever you reach them), so everything it drafts is a reply, a chase or
 * a thank-you in a conversation that already exists, and the answer is the same at every stage.
 *
 *  - an address on file          -> `email`: a draft, as always;
 *  - no address, a handle        -> `manual:<handle>`: the SAME drafted text, stored with that channel, and a
 *                                   task so a person sends it by hand;
 *  - nothing at all              -> `no_contact`: no draft, one task to find contact details.
 */
export type Delivery = 'email' | `manual:${SpeakerHandleKind}` | 'no_contact';

/** First handle wins, in this order. */
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

/**
 * What a "Reach out to <name> about <event>" task carries: a SUGGESTION, never a drafted message. The agent
 * does not word the first message; it says who, why now, and where to find them.
 */
export function outreachSuggestion(
  speaker: Pick<Speaker, 'name' | 'topics' | 'emails' | 'handles'>,
  event: Pick<Event, 'title' | 'date' | 'theme'>,
): string {
  const how = chooseDelivery(speaker);
  const where =
    how === 'email'
      ? `by email (${speaker.emails[0] ?? ''})`
      : how === 'no_contact'
        ? 'no address or handle on file yet: find one first'
        : `on ${how.slice('manual:'.length)} (${speaker.handles[how.slice('manual:'.length) as SpeakerHandleKind] ?? ''})`;
  const parts = [
    `Invite ${speaker.name} to speak at ${event.title}${event.date ? ` on ${event.date.slice(0, 10)}` : ''}.`,
    event.theme ? `Event theme: ${event.theme}.` : '',
    speaker.topics.length > 0 ? `Their topics: ${speaker.topics.join(', ')}.` : '',
    `Reach them ${where}.`,
    'Nothing was drafted: write it yourself, then record it ("speakers sent --kind invitation") or set them to invited.',
  ];
  return parts.filter(Boolean).join(' ');
}
