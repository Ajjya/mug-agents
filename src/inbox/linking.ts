import type { InboundMessage } from '../domain/inbox.schema.js';
import type { Speaker } from '../domain/speaker.schema.js';
import type { SpeakersRepository } from '../repositories/speakers.repository.js';
import type { ContactsRepository, InboundMessagesRepository } from './repositories.js';

/**
 * Linking is deterministic, in code, with no model (spec 7.2):
 *  1. the sender's address matches a speaker's email or a contact's address -> link;
 *  2. the Gmail thread matches a thread we have seen -> inherit its links;
 *  3. otherwise `unlinked`, and it waits for a human (`inbox link`).
 * A fuzzy NAME match is deliberately not a link: two people share a name eventually, and a wrong link
 * puts someone's mail on another person's record.
 */

export interface LinkResult {
  linkState: 'auto' | 'unlinked';
  speakerId?: string;
  organisationId?: string;
  /** Set only when the event is certain. */
  eventId?: string;
  /**
   * The events whose `lastInboundAt` this message moves. When the speaker is in several active events
   * and the thread does not say which, ALL of them: pausing a chase too widely is a nuisance, chasing
   * someone who has written back is the worst failure this system can produce.
   */
  eventIds: string[];
  via?: 'address' | 'thread';
}

export interface LinkDeps {
  speakers: SpeakersRepository;
  contacts: ContactsRepository;
  inbound: InboundMessagesRepository;
}

/** Events a speaker is still in play for (anything but thanked). */
export function activeEventIds(speaker: Pick<Speaker, 'perEvent'>): string[] {
  return speaker.perEvent.filter((p) => p.status !== 'thanked').map((p) => p.eventId);
}

export async function resolveLink(
  input: { fromAddress: string; threadId: string },
  deps: LinkDeps,
): Promise<LinkResult> {
  const [speakerByEmail, contact] = await Promise.all([
    deps.speakers.findByEmail(input.fromAddress),
    deps.contacts.findByAddress(input.fromAddress),
  ]);
  let speakerId = speakerByEmail?._id ?? contact?.speakerId;
  let organisationId = contact?.organisationId;
  let via: LinkResult['via'] = speakerId || organisationId ? 'address' : undefined;

  const earlier: InboundMessage | undefined = (await deps.inbound.findByThreadId(input.threadId))
    .filter((m) => m.linkedSpeakerId !== undefined || m.linkedOrganisationId !== undefined)
    .at(-1);
  if (!speakerId && !organisationId && earlier) {
    speakerId = earlier.linkedSpeakerId;
    organisationId = earlier.linkedOrganisationId;
    via = 'thread';
  }
  if (!speakerId && !organisationId) return { linkState: 'unlinked', eventIds: [] };

  let eventId: string | undefined;
  let eventIds: string[] = [];
  if (speakerId) {
    const speaker = speakerByEmail ?? (await deps.speakers.findById(speakerId));
    const active = speaker ? activeEventIds(speaker) : [];
    const inherited = earlier?.linkedSpeakerId === speakerId ? earlier.linkedEventId : undefined;
    if (inherited && active.includes(inherited)) eventId = inherited;
    else if (active.length === 1) eventId = active[0];
    eventIds = eventId ? [eventId] : active;
  } else if (earlier?.linkedEventId) {
    eventId = earlier.linkedEventId;
  }
  return {
    linkState: 'auto',
    ...(speakerId ? { speakerId } : {}),
    ...(organisationId ? { organisationId } : {}),
    ...(eventId ? { eventId } : {}),
    eventIds,
    ...(via ? { via } : {}),
  };
}

/**
 * Sets `lastInboundAt` (to the message's own received time, never later than what is already there)
 * on the given events of a speaker, and writes NOTHING else: not the status, not `updatedAt`, not any
 * identity field. Idempotent. A no-op when nothing would change.
 */
export async function recordInbound(
  speakers: SpeakersRepository,
  speakerId: string,
  eventIds: readonly string[],
  receivedAt: string,
): Promise<boolean> {
  const wanted = new Set(eventIds.map((e) => e.toLowerCase()));
  const needs = (p: Speaker['perEvent'][number]): boolean =>
    wanted.has(p.eventId.toLowerCase()) &&
    (p.lastInboundAt === undefined || p.lastInboundAt < receivedAt);
  const current = await speakers.findById(speakerId);
  if (!current?.perEvent.some(needs)) return false;
  await speakers.updateWithRetry(speakerId, (s) => ({
    perEvent: s.perEvent.map((p) => (needs(p) ? { ...p, lastInboundAt: receivedAt } : p)),
  }));
  return true;
}
