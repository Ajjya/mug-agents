import type { Event } from '../../domain/event.schema.js';
import {
  type Message,
  type MessageChannel,
  type MessageFacts,
  type MessageKind,
  isRecordedOutside,
  messageIdempotencyKey,
  recordedBy,
} from '../../domain/message.schema.js';
import type { Organisation } from '../../domain/organisation.schema.js';
import type { Speaker, SpeakerStatus } from '../../domain/speaker.schema.js';
import type { Task } from '../../domain/task.schema.js';
import { DuplicateKeyError } from '../../repositories/base.repository.js';
import type { EventsRepository } from '../../repositories/events.repository.js';
import type { MessagesRepository } from '../../repositories/messages.repository.js';
import type { OrganisationsRepository } from '../../repositories/organisations.repository.js';
import type { SpeakersRepository } from '../../repositories/speakers.repository.js';
import type { TasksRepository } from '../../repositories/tasks.repository.js';
import { EventNotFoundError, allPages } from '../planner/plan-persistence.js';
import type { BlockedItem } from './decide.js';
import { channelOf, chooseDelivery } from './delivery.js';
import { assertTransition } from './transitions.js';

export class SpeakerNotInEventError extends Error {
  constructor(
    public readonly speakerId: string,
    public readonly eventId: string,
  ) {
    super(`Speaker ${speakerId} has no pipeline entry for event ${eventId}`);
    this.name = 'SpeakerNotInEventError';
  }
}

export class MessageNotFoundError extends Error {
  constructor(public readonly messageId: string) {
    super(`No message with id ${messageId}`);
    this.name = 'MessageNotFoundError';
  }
}

export class MessageNotSendableError extends Error {
  constructor(
    public readonly messageId: string,
    reason: string,
  ) {
    super(`Message ${messageId} cannot be marked sent: ${reason}`);
    this.name = 'MessageNotSendableError';
  }
}

/** A draft as the graph produced it, before it has an id. */
export interface DraftRecord {
  eventId: string;
  speakerId: string;
  kind: MessageKind;
  round: number;
  reason: string;
  subject: string;
  body: string;
  facts: MessageFacts;
  needsApproval: boolean;
  /** Where it is delivered: `email`, or the handle a person sends it on by hand. */
  channel: MessageChannel;
}

export interface LoadedPipeline {
  event: Event;
  venue: Organisation | null;
  speakers: Speaker[];
  messages: Message[];
  /** Speakers who have had any message marked sent, for any event (first contact otherwise). */
  priorSent: string[];
}

const PENDING = new Set(['draft', 'approved']);

export const sendKey = (messageId: string): string => `send:${messageId}`;
export const FIND_CONTACT_KEY = 'find-contact';

/** `chase-limit:<kind>` on a task with relatedSpeakerId: the blocked item's natural key. */
export const chaseLimitKey = (kind: MessageKind): string => `chase-limit:${kind}`;

const KIND_LABEL: Record<MessageKind, string> = {
  invitation: 'the invitation',
  chase_reply: 'the invitation',
  chase_abstract: 'the abstract',
  chase_bio: 'the bio',
  chase_photo: 'the photo',
  chase_slides: 'the slides',
  thank_you: 'the thank-you',
};

const chases = (n: number): string => `${String(n)} ${n === 1 ? 'chase' : 'chases'} unanswered`;

/** The task a blocked item becomes. */
export function blockedTaskTitle(speakerName: string, item: BlockedItem): string {
  const about = `Call ${speakerName} about ${KIND_LABEL[item.kind]}`;
  if (item.why === 'limit') return `${about} — ${chases(item.roundsSent)}`;
  return item.roundsSent > 0
    ? `${about} — ${chases(item.roundsSent)}, too close to the event to chase again`
    : `${about} — too close to the event to chase by email`;
}

/**
 * Everything the Speakers agent reads and writes. It WRITES only `messages`, `tasks` and
 * `speakers.perEvent[].status`: never a speaker (no insert, no name/email/bio/photo), never an event.
 * Every write is idempotent by natural key, so a node re-run after a resume writes nothing twice.
 */
export class SpeakerPipelineStore {
  constructor(
    private readonly events: EventsRepository,
    private readonly speakers: SpeakersRepository,
    private readonly organisations: OrganisationsRepository,
    private readonly messages: MessagesRepository,
    private readonly tasks: TasksRepository,
    /** Owner of tasks the agent creates for a human. */
    private readonly taskOwner: string,
  ) {}

  async mustFindEvent(eventId: string): Promise<Event> {
    const event = await this.events.findById(eventId);
    if (!event) throw new EventNotFoundError(eventId);
    return event;
  }

  async load(eventId: string): Promise<LoadedPipeline> {
    const event = await this.mustFindEvent(eventId);
    const venue = event.venueOrganisationId
      ? await this.organisations.findById(event.venueOrganisationId)
      : null;
    const speakers = await allPages((after) =>
      this.speakers.findByEventId(event._id, { limit: 200, ...(after ? { after } : {}) }),
    );
    const messages = await this.eventMessages(event._id);
    const priorSent: string[] = [];
    for (const s of speakers) {
      const sent = await this.messages.findBySpeakerAndStatus(s._id, 'sent', { limit: 1 });
      if (sent.items.length > 0) priorSent.push(s._id);
    }
    return { event, venue, speakers, messages, priorSent };
  }

  async eventMessages(eventId: string): Promise<Message[]> {
    return await allPages((after) =>
      this.messages.findByEventId(eventId, { limit: 200, ...(after ? { after } : {}) }),
    );
  }

  /** Inserts a draft unless its natural key exists; returns the stored one either way. */
  async upsertDraft(draft: DraftRecord): Promise<{ message: Message; created: boolean }> {
    const idempotencyKey = messageIdempotencyKey(
      draft.eventId,
      draft.speakerId,
      draft.kind,
      draft.round,
    );
    const existing = await this.messages.findByIdempotencyKey(idempotencyKey);
    if (existing) return { message: existing, created: false };
    try {
      const message = await this.messages.insert({
        ...draft,
        status: 'draft',
        idempotencyKey,
      });
      return { message, created: true };
    } catch (err) {
      if (!(err instanceof DuplicateKeyError)) throw err;
      const raced = await this.messages.findByIdempotencyKey(idempotencyKey);
      if (!raced) throw err;
      return { message: raced, created: false };
    }
  }

  /** Marks an unsent draft superseded. A no-op once it is sent, rejected or already superseded. */
  async supersede(messageId: string): Promise<boolean> {
    const current = await this.messages.findById(messageId);
    if (!current || !PENDING.has(current.status)) return false;
    // Re-checked inside the retry: a concurrent `sent` wins and the status is left as it is.
    const updated = await this.messages.updateWithRetry(messageId, (m) => ({
      status: PENDING.has(m.status) ? 'superseded' : m.status,
    }));
    if (updated?.status === 'superseded') await this.closeSendTask(updated, 'cancelled');
    return updated?.status === 'superseded';
  }

  /** One task per (event, speaker, kind) at the chase limit. */
  async ensureBlockedTask(
    eventId: string,
    item: BlockedItem,
    speakerName: string,
  ): Promise<{ task: Task; created: boolean }> {
    const key = chaseLimitKey(item.kind);
    const existing = (
      await allPages((after) =>
        this.tasks.findByEventId(eventId, { limit: 200, ...(after ? { after } : {}) }),
      )
    ).find(
      (t) =>
        t.milestoneKey === key &&
        t.relatedSpeakerId?.toLowerCase() === item.speakerId.toLowerCase(),
    );
    if (existing) return { task: existing, created: false };
    const task = await this.tasks.insert({
      title: blockedTaskTitle(speakerName, item),
      owner: this.taskOwner,
      status: 'open',
      source: 'agent',
      relatedEventId: eventId,
      relatedSpeakerId: item.speakerId,
      milestoneKey: key,
    });
    return { task, created: true };
  }

  /** The task for one message a person sends by hand, if it exists. Natural key: `send:<message id>`. */
  private async findSendTask(eventId: string, messageId: string): Promise<Task | undefined> {
    return (
      await allPages((after) =>
        this.tasks.findByEventId(eventId, { limit: 200, ...(after ? { after } : {}) }),
      )
    ).find((t) => t.milestoneKey === sendKey(messageId));
  }

  /**
   * "Send to <name> on <channel>": one task per drafted message whose channel a person sends on by hand,
   * so a draft nobody pastes into LinkedIn cannot be forgotten. Idempotent by message.
   */
  async ensureSendTask(
    message: Pick<Message, '_id' | 'eventId' | 'speakerId' | 'channel'>,
    speakerName: string,
  ): Promise<{ task: Task; created: boolean }> {
    const existing = await this.findSendTask(message.eventId, message._id);
    if (existing) return { task: existing, created: false };
    const task = await this.tasks.insert({
      title: `Send to ${speakerName} on ${message.channel}`,
      owner: this.taskOwner,
      status: 'open',
      source: 'agent',
      relatedEventId: message.eventId,
      relatedSpeakerId: message.speakerId,
      milestoneKey: sendKey(message._id),
    });
    return { task, created: true };
  }

  /** A task for a message that was sent or no longer applies is finished with it. Only ever closes an open one. */
  private async closeSendTask(message: Message, status: 'done' | 'cancelled'): Promise<void> {
    const task = await this.findSendTask(message.eventId, message._id);
    if (task && (task.status === 'open' || task.status === 'doing')) {
      await this.tasks.updateWithRetry(task._id, () => ({ status }));
    }
  }

  /** One task per (event, speaker) when something is due and there is no way to reach them at all. */
  async ensureFindContactTask(
    eventId: string,
    speakerId: string,
    speakerName: string,
  ): Promise<{ task: Task; created: boolean }> {
    const existing = (
      await allPages((after) =>
        this.tasks.findByEventId(eventId, { limit: 200, ...(after ? { after } : {}) }),
      )
    ).find(
      (t) =>
        t.milestoneKey === FIND_CONTACT_KEY &&
        t.relatedSpeakerId?.toLowerCase() === speakerId.toLowerCase(),
    );
    if (existing) return { task: existing, created: false };
    const task = await this.tasks.insert({
      title: `Find contact details for ${speakerName}`,
      owner: this.taskOwner,
      status: 'open',
      source: 'agent',
      relatedEventId: eventId,
      relatedSpeakerId: speakerId,
      milestoneKey: FIND_CONTACT_KEY,
    });
    return { task, created: true };
  }

  /** Applies a review outcome to drafts still in `draft`; anything else is left as it is. */
  async review(
    ids: readonly string[],
    outcome:
      | { status: 'approved'; approvalRequestId: string }
      | { status: 'rejected'; reason: string; at: string },
  ): Promise<number> {
    let changed = 0;
    for (const id of ids) {
      const current = await this.messages.findById(id);
      if (current?.status !== 'draft') continue;
      const updated = await this.messages.updateWithRetry(id, (m) => {
        if (m.status !== 'draft') return { status: m.status };
        return outcome.status === 'approved'
          ? { status: 'approved', approvalRequestId: outcome.approvalRequestId }
          : { status: 'rejected', rejectionReason: outcome.reason, rejectedAt: outcome.at };
      });
      if (updated?.status === outcome.status) changed++;
    }
    return changed;
  }

  async findMessage(messageId: string): Promise<Message> {
    const m = await this.messages.findById(messageId);
    if (!m) throw new MessageNotFoundError(messageId);
    return m;
  }

  async findSpeaker(speakerId: string): Promise<Speaker | null> {
    return await this.speakers.findById(speakerId);
  }

  /**
   * A human says a draft went out. Only a draft or an approved message can be sent, and a draft that
   * needs approval must be approved first. Sending an invitation moves the speaker idea -> invited;
   * sending a thank-you moves slides_received -> thanked (through the transition guard).
   */
  async markSent(messageId: string, sentBy: string, now: Date): Promise<Message> {
    const m = await this.findMessage(messageId);
    let sent = m;
    if (m.status !== 'sent') {
      if (m.status === 'draft' && m.needsApproval) {
        throw new MessageNotSendableError(
          messageId,
          'it needs approval first (npm run approvals -- list)',
        );
      }
      if (m.status !== 'draft' && m.status !== 'approved') {
        throw new MessageNotSendableError(messageId, `it is ${m.status}`);
      }
      sent =
        (await this.messages.updateWithRetry(messageId, (doc) => {
          if (doc.status !== 'draft' && doc.status !== 'approved') {
            throw new MessageNotSendableError(messageId, `it is ${doc.status}`);
          }
          return { status: 'sent', sentAt: now.toISOString(), sentBy };
        })) ?? m;
    }
    // Also on a repeated `sent`: if a crash came between the two writes, this finishes the job. It
    // applies only while the status is unchanged since the send, so a later human change (a speaker
    // parked back to idea) is never undone.
    if (sent.sentAt)
      await this.followStatus(m.kind, m.speakerId, m.eventId, sent.sentAt, now, false);
    if (sent.status === 'sent') await this.closeSendTask(sent, 'done');
    return sent;
  }

  /** The status step a sent message implies: invitation idea -> invited, thank-you -> thanked. */
  private async followStatus(
    kind: MessageKind,
    speakerId: string,
    eventId: string,
    sentAt: string,
    now: Date,
    explicit: boolean,
  ): Promise<void> {
    const follow: Partial<Record<MessageKind, [SpeakerStatus, SpeakerStatus]>> = {
      invitation: ['idea', 'invited'],
      thank_you: ['slides_received', 'thanked'],
    };
    const step = follow[kind];
    if (!step) return;
    const entry = await this.entry(speakerId, eventId);
    // An explicit human record ("I sent it on 25 Oct") is the latest word, whatever its date; a
    // repeated `sent` only completes a send, so it must not undo a status change made since.
    if (entry.status === step[0] && (explicit || entry.updatedAt <= sentAt)) {
      await this.setStatus(speakerId, eventId, step[1], now);
    }
  }

  /**
   * A send done outside this system, recorded afterwards: creates a message already `sent`, with no
   * text and `sentBy` marking it as recorded. Chases then measure from `sentAt` like any other.
   * Idempotent: with an explicit round the natural key makes a second call a no-op; without one, a
   * recorded send of the same kind on the same day is the same send.
   */
  async recordSent(
    input: {
      eventId: string;
      speakerId: string;
      kind: MessageKind;
      sentAt: string;
      by: string;
      round?: number;
      /** Where it was sent; default: how this speaker is reached now (a handle, else email). */
      channel?: MessageChannel;
    },
    now: Date,
  ): Promise<{ message: Message; created: boolean }> {
    await this.entry(input.speakerId, input.eventId); // the speaker must be in this event's pipeline
    const speaker = await this.speakers.findById(input.speakerId);
    const channel =
      input.channel ?? (speaker ? (channelOf(chooseDelivery(speaker)) ?? 'other') : 'email');
    const mine = (await this.eventMessages(input.eventId)).filter(
      (m) => m.speakerId.toLowerCase() === input.speakerId.toLowerCase() && m.kind === input.kind,
    );
    const day = input.sentAt.slice(0, 10);
    if (input.round === undefined) {
      const same = mine.find((m) => isRecordedOutside(m) && m.sentAt?.slice(0, 10) === day);
      if (same) return { message: same, created: false };
    }
    const pending = mine.find((m) => m.status === 'draft' || m.status === 'approved');
    if (pending) {
      throw new MessageNotSendableError(
        pending._id,
        `a ${input.kind} draft (round ${String(pending.round)}, ${pending.status}) already exists for this speaker: mark that one with "speakers sent ${pending._id}" instead of recording a second`,
      );
    }
    const round = input.round ?? Math.max(0, ...mine.map((m) => m.round)) + 1;
    const idempotencyKey = messageIdempotencyKey(input.eventId, input.speakerId, input.kind, round);
    const existing = await this.messages.findByIdempotencyKey(idempotencyKey);
    if (existing) return { message: existing, created: false };
    let message: Message;
    try {
      message = await this.messages.insert({
        eventId: input.eventId,
        speakerId: input.speakerId,
        kind: input.kind,
        channel,
        round,
        subject: '(sent outside this system)',
        body: '',
        facts: {},
        reason: 'recorded as sent outside this system',
        needsApproval: false,
        status: 'sent',
        idempotencyKey,
        sentAt: input.sentAt,
        sentBy: recordedBy(input.by),
      });
    } catch (err) {
      if (!(err instanceof DuplicateKeyError)) throw err;
      const raced = await this.messages.findByIdempotencyKey(idempotencyKey);
      if (!raced) throw err;
      return { message: raced, created: false };
    }
    await this.followStatus(input.kind, input.speakerId, input.eventId, input.sentAt, now, true);
    return { message, created: true };
  }

  private async entry(
    speakerId: string,
    eventId: string,
  ): Promise<{ status: SpeakerStatus; updatedAt: string }> {
    const s = await this.speakers.findById(speakerId);
    const entry = s?.perEvent.find((p) => p.eventId.toLowerCase() === eventId.toLowerCase());
    if (!entry) throw new SpeakerNotInEventError(speakerId, eventId);
    return entry;
  }

  async currentStatus(speakerId: string, eventId: string): Promise<SpeakerStatus> {
    return (await this.entry(speakerId, eventId)).status;
  }

  /** The only status write. Patches `perEvent` and nothing else on the speaker. */
  async setStatus(
    speakerId: string,
    eventId: string,
    to: SpeakerStatus,
    now: Date,
  ): Promise<{ from: SpeakerStatus; to: SpeakerStatus }> {
    let from: SpeakerStatus | undefined;
    const updated = await this.speakers.updateWithRetry(speakerId, (s) => {
      const entry = s.perEvent.find((p) => p.eventId.toLowerCase() === eventId.toLowerCase());
      if (!entry) throw new SpeakerNotInEventError(speakerId, eventId);
      assertTransition(entry.status, to);
      from = entry.status;
      return {
        perEvent: s.perEvent.map((p) =>
          p === entry ? { ...p, status: to, updatedAt: now.toISOString() } : p,
        ),
      };
    });
    if (!updated || from === undefined) throw new SpeakerNotInEventError(speakerId, eventId);
    return { from, to };
  }
}
