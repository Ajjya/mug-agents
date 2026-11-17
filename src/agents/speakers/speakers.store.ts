import type { Event } from '../../domain/event.schema.js';
import {
  type Message,
  type MessageFacts,
  type MessageKind,
  messageIdempotencyKey,
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
        channel: 'email',
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

  /** Applies a review outcome to drafts still in `draft`; anything else is left as it is. */
  async review(
    ids: readonly string[],
    outcome:
      { status: 'approved'; approvalRequestId: string } | { status: 'rejected'; reason: string },
  ): Promise<number> {
    let changed = 0;
    for (const id of ids) {
      const current = await this.messages.findById(id);
      if (current?.status !== 'draft') continue;
      const updated = await this.messages.updateWithRetry(id, (m) => {
        if (m.status !== 'draft') return { status: m.status };
        return outcome.status === 'approved'
          ? { status: 'approved', approvalRequestId: outcome.approvalRequestId }
          : { status: 'rejected', rejectionReason: outcome.reason };
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
    if (m.status === 'sent') return m;
    if (m.status === 'draft' && m.needsApproval) {
      throw new MessageNotSendableError(
        messageId,
        'it needs approval first (npm run approvals -- list)',
      );
    }
    if (m.status !== 'draft' && m.status !== 'approved') {
      throw new MessageNotSendableError(messageId, `it is ${m.status}`);
    }
    const sent = await this.messages.updateWithRetry(messageId, (doc) => {
      if (doc.status !== 'draft' && doc.status !== 'approved') {
        throw new MessageNotSendableError(messageId, `it is ${doc.status}`);
      }
      return { status: 'sent', sentAt: now.toISOString(), sentBy };
    });
    const follow: Partial<Record<MessageKind, [SpeakerStatus, SpeakerStatus]>> = {
      invitation: ['idea', 'invited'],
      thank_you: ['slides_received', 'thanked'],
    };
    const step = follow[m.kind];
    if (step) {
      const current = await this.currentStatus(m.speakerId, m.eventId);
      if (current === step[0]) await this.setStatus(m.speakerId, m.eventId, step[1], now);
    }
    return sent ?? m;
  }

  async currentStatus(speakerId: string, eventId: string): Promise<SpeakerStatus> {
    const s = await this.speakers.findById(speakerId);
    const entry = s?.perEvent.find((p) => p.eventId.toLowerCase() === eventId.toLowerCase());
    if (!entry) throw new SpeakerNotInEventError(speakerId, eventId);
    return entry.status;
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
