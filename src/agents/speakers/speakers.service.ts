import { type RoutedDecision, routeDelivery } from './delivery.js';
import { z } from 'zod';
import {
  MESSAGE_KINDS,
  type Message,
  type MessageKind,
  isRecordedOutside,
} from '../../domain/message.schema.js';
import type { Speaker, SpeakerStatus } from '../../domain/speaker.schema.js';
import { threadIdFor } from '../../graph/thread.js';
import { ProviderUnavailableError, StructuredOutputError } from '../../llm/errors.js';
import type { LlmCallRecord } from '../../llm/model.types.js';
import type {
  ApprovalDecisionsRepository,
  ApprovalRequestsRepository,
} from '../../approvals/approvals.repository.js';
import { type ChasePolicy, decideActions, type PlannedAction, type Redraft } from './decide.js';
import { NODE_REQUEST_APPROVAL } from './speakers.graph.js';
import type { SpeakersRuntime, SpeakersThreadView } from './speakers.runtime.js';
import { pipelineInput, statusFor } from './pipeline.js';
import type { SpeakerPipelineStore } from './speakers.store.js';

/** A run stopped on a provider or model failure; the thread keeps its progress and is resumable. */
export class SpeakersRunInterruptedError extends Error {
  constructor(
    public readonly threadId: string,
    public override readonly cause: ProviderUnavailableError | StructuredOutputError,
  ) {
    super(
      `${cause instanceof ProviderUnavailableError ? 'Provider failure' : 'Model failure'} in speakers run ${threadId}: ${cause.message}. ` +
        `The run is resumable: npm run approvals -- resume ${threadId}`,
    );
    this.name = 'SpeakersRunInterruptedError';
  }
}

/** The part of the graph state a run's result reads, validated rather than cast. */
const ids = z.array(z.string()).nullable().optional();
const RunSummarySchema = z.looseObject({
  eventId: z.string().optional(),
  decision: z
    .custom<RoutedDecision>((v) => v === null || v === undefined || typeof v === 'object')
    .nullable()
    .optional(),
  created: ids,
  existing: ids,
  superseded: ids,
  tasksCreated: z.number().nullable().optional(),
});

/** A decision was recorded for the pending review but never delivered: deliver it, don't replace it. */
export class PendingDecisionUndeliveredError extends Error {
  constructor(
    public readonly threadId: string,
    public readonly requestId: string,
  ) {
    super(
      `Request ${requestId} has a recorded decision that was not delivered. Run: npm run approvals -- resume ${threadId}`,
    );
    this.name = 'PendingDecisionUndeliveredError';
  }
}

export interface RunResult {
  status: 'awaiting_approval' | 'completed';
  threadId: string;
  /** The pending approval request this run retired (its drafts are asked for again). */
  replaced?: string;
  decision: RoutedDecision | null;
  /** Drafts this run created (a second run for the same day creates none). */
  created: Message[];
  existing: number;
  tasksCreated: number;
  superseded: number;
  outcome?: 'persisted' | 'rejected';
  requestId?: string;
  calls: LlmCallRecord[];
}

/** A message in the event's pipeline, as `list` shows it. */
export interface MessageRow {
  id: string;
  speakerId: string;
  speakerName: string;
  kind: MessageKind;
  round: number;
  status: Message['status'];
  needsApproval: boolean;
  /** When it was sent, else when it was drafted. */
  at: string;
  /** A send recorded outside the system: no text. */
  recorded: boolean;
}

/** What `list` hides unless asked: drafts that are no longer part of the work. */
export const HIDDEN_BY_DEFAULT: readonly Message['status'][] = ['superseded', 'rejected'];

export interface PipelineRow {
  speakerId: string;
  name: string;
  status: SpeakerStatus;
  lastSent?: { kind: string; at: string };
  next: string;
}

/**
 * The Speakers agent's entry points. `run` is the only one that can call a model. `sent` and `status`
 * are how a human tells the agent what happened: nothing reads an inbox before M4, so the pipeline is
 * only as current as what it has been told.
 */
export class SpeakersService {
  constructor(
    private readonly store: SpeakerPipelineStore,
    private readonly runtime: SpeakersRuntime,
    private readonly requests: ApprovalRequestsRepository,
    private readonly decisions: ApprovalDecisionsRepository,
    private readonly policy: ChasePolicy,
  ) {}

  async run(
    eventId: string,
    options: { now?: Date; redraft?: readonly Redraft[] } = {},
  ): Promise<RunResult> {
    for (const r of options.redraft ?? []) {
      if (!(MESSAGE_KINDS as readonly string[]).includes(r.kind))
        throw new RangeError(`--redraft needs a message kind, one of: ${MESSAGE_KINDS.join(', ')}`);
    }
    const event = await this.store.mustFindEvent(eventId); // before any thread exists
    const threadId = threadIdFor(event._id, 'speakers');
    const before = await this.runtime.inspect(threadId);
    const callsBefore = before.calls.length;
    let replaced: string | undefined;
    if (before.status === 'awaiting_decision') {
      // A pending review must not stop every later run for the event (chases for other speakers
      // included). The pending request is retired (status `expired`, nothing deleted) and a new run
      // asks again: its review holds the still-unapproved drafts plus any new ones.
      const request = before.runId
        ? await this.requests.findByKey(threadId, before.runId, NODE_REQUEST_APPROVAL)
        : null;
      if (request && (await this.decisions.findByRequestId(request._id))) {
        throw new PendingDecisionUndeliveredError(threadId, request._id);
      }
      if (request?.status === 'pending') {
        await this.requests.updateWithRetry(request._id, (r) => ({
          status: r.status === 'pending' ? 'expired' : r.status,
        }));
        replaced = request._id;
      }
    }
    if (before.status === 'resumable' && (options.redraft?.length ?? 0) > 0) {
      throw new RangeError(
        `A previous run of this event stopped part-way; finish it first (npm run approvals -- resume ${threadId}), then use --redraft.`,
      );
    }
    const view = await this.guard(threadId, () =>
      before.status === 'resumable'
        ? this.runtime.continue(threadId)
        : // A waiting thread is started again with new input: LangGraph begins a new run from
          // START and the old interrupt is dropped (verified in the speakers workflow tests).
          this.runtime.start(threadId, {
            eventId: event._id,
            ...(options.now ? { now: options.now } : {}),
            ...(options.redraft ? { redraft: options.redraft } : {}),
          }),
    );
    return { ...(await this.result(view, callsBefore)), ...(replaced ? { replaced } : {}) };
  }

  /** The pipeline as a table: who is where, what was last sent, what comes next. No model, no writes. */
  async list(
    eventId: string,
    now: Date = new Date(),
    options: { all?: boolean } = {},
  ): Promise<{ rows: PipelineRow[]; notes: string[]; messages: MessageRow[]; hidden: number }> {
    const p = await this.store.load(eventId);
    const d = routeDelivery(
      decideActions(
        pipelineInput(p, now, { ...this.policy, maxDraftsPerRun: Number.MAX_SAFE_INTEGER }),
      ),
      p.speakers,
      Number.MAX_SAFE_INTEGER,
    );
    const describe = (a: PlannedAction & { delivery?: string }): string =>
      `${a.kind} #${String(a.round)} due now${a.delivery && a.delivery !== 'email' ? ` (${a.delivery.replace(':', ' on ')}, by hand)` : ''}`;
    const rows = p.speakers.map((s): PipelineRow => {
      const sent = p.messages
        .filter((m) => m.speakerId === s._id && m.status === 'sent' && m.sentAt)
        .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''))
        .at(-1);
      const next = [
        ...d.actions.filter((a) => a.speakerId === s._id).map(describe),
        ...d.outreach
          .filter((o) => o.speakerId === s._id)
          .map((o) => `reach out: a task for you (${o.reason})`),
        ...d.noContact
          .filter((a) => a.speakerId === s._id)
          .map((a) => `${a.kind} #${String(a.round)} due: no contact details, find them`),
        ...d.blocked
          .filter((b) => b.speakerId === s._id)
          .map((b) => `${b.kind}: chase limit, call them`),
        ...d.waiting
          .filter((w) => w.speakerId === s._id)
          .map(
            (w) => `${w.kind ? `${w.kind}: ` : 'reply: '}${w.why}${w.dueOn ? ` (${w.dueOn})` : ''}`,
          ),
      ];
      return {
        speakerId: s._id,
        name: s.name,
        status: statusFor(s, p.event._id),
        ...(sent?.sentAt ? { lastSent: { kind: sent.kind, at: sent.sentAt } } : {}),
        next: next.join('; ') || '-',
      };
    });
    const shown = p.messages.filter((m) => options.all || !HIDDEN_BY_DEFAULT.includes(m.status));
    const messages = shown.map((m): MessageRow => ({
      id: m._id,
      speakerId: m.speakerId,
      speakerName: p.speakers.find((s) => s._id === m.speakerId)?.name ?? m.speakerId,
      kind: m.kind,
      round: m.round,
      status: m.status,
      needsApproval: m.needsApproval,
      at: m.sentAt ?? m.createdAt,
      recorded: isRecordedOutside(m),
    }));
    return { rows, notes: d.notes, messages, hidden: p.messages.length - shown.length };
  }

  /**
   * For `candidates --event`: the topic defaults to the event's theme (else its title), and who is
   * already in the event's pipeline, with their status, so a suggestion is not mistaken for news.
   */
  async candidateContext(
    eventId: string,
  ): Promise<{ topic: string; inPipeline: Map<string, SpeakerStatus> }> {
    const p = await this.store.load(eventId);
    return {
      topic: p.event.theme ?? p.event.title,
      inPipeline: new Map(p.speakers.map((s) => [s._id, statusFor(s, p.event._id)])),
    };
  }

  async show(messageId: string): Promise<{
    message: Message;
    speakerId: string;
    speakerName: string;
    emails: string[];
    handles: Speaker['handles'];
  }> {
    const message = await this.store.findMessage(messageId);
    const speaker = await this.store.findSpeaker(message.speakerId);
    return {
      message,
      speakerId: message.speakerId,
      speakerName: speaker?.name ?? message.speakerId,
      emails: speaker?.emails ?? [],
      handles: speaker?.handles ?? {},
    };
  }

  async sent(messageId: string, by: string, now: Date = new Date()): Promise<Message> {
    return await this.store.markSent(messageId, by, now);
  }

  /**
   * Records a send done outside this system (a message that is not a draft here). It is a message
   * already `sent`, with no text, so chases and the first-contact rule treat it like any other.
   */
  async recordSent(
    input: {
      eventId: string;
      speakerId: string;
      kind: MessageKind;
      /** `YYYY-MM-DD` or a full ISO instant; a date means noon UTC. Not in the future. */
      on: string;
      by: string;
      round?: number;
    },
    now: Date = new Date(),
  ): Promise<{ message: Message; created: boolean }> {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? `${input.on}T12:00:00.000Z` : input.on;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()))
      throw new RangeError(`--on must be an ISO date, got "${input.on}"`);
    if (at.getTime() > now.getTime() + 86_400_000)
      throw new RangeError(`--on ${input.on} is in the future: record a send that has happened`);
    return await this.store.recordSent({ ...input, sentAt: at.toISOString() }, now);
  }

  async setStatus(
    speakerId: string,
    eventId: string,
    to: SpeakerStatus,
    now: Date = new Date(),
  ): Promise<{ from: SpeakerStatus; to: SpeakerStatus }> {
    return await this.store.setStatus(speakerId, eventId, to, now);
  }

  /** Names for ids, so output can say who a line is about (an id the store cannot find maps to itself). */
  async speakerNames(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) out.set(id, (await this.store.findSpeaker(id))?.name ?? id);
    return out;
  }

  /** Starts speakers in an event's pipeline (default status `idea`). Idempotent; see the store. */
  async addToEvent(
    refs: readonly string[],
    eventId: string,
    status: SpeakerStatus = 'idea',
    now: Date = new Date(),
  ) {
    return await this.store.addToEvent(refs, eventId, status, now);
  }

  /** NOT a delete: the entry becomes `declined`, with the reason. */
  async removeFromEvent(ref: string, eventId: string, reason: string, now: Date = new Date()) {
    return await this.store.removeFromEvent(ref, eventId, reason, now);
  }

  private async guard(
    threadId: string,
    run: () => Promise<SpeakersThreadView>,
  ): Promise<SpeakersThreadView> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ProviderUnavailableError || err instanceof StructuredOutputError) {
        throw new SpeakersRunInterruptedError(threadId, err);
      }
      throw err;
    }
  }

  private async result(view: SpeakersThreadView, callsBefore: number): Promise<RunResult> {
    const values = RunSummarySchema.parse(await this.runtime.values(view.threadId));
    const createdIds = values.created ?? [];
    const all = values.eventId ? await this.store.eventMessages(values.eventId) : [];
    const base = {
      threadId: view.threadId,
      decision: values.decision ?? null,
      created: all.filter((m) => createdIds.includes(m._id)),
      existing: values.existing?.length ?? 0,
      tasksCreated: values.tasksCreated ?? 0,
      superseded: values.superseded?.length ?? 0,
      calls: view.calls.slice(callsBefore),
    };
    if (view.status === 'awaiting_decision') {
      const request =
        view.runId === undefined
          ? null
          : await this.requests.findByKey(view.threadId, view.runId, NODE_REQUEST_APPROVAL);
      return {
        ...base,
        status: 'awaiting_approval',
        ...(request ? { requestId: request._id } : {}),
      };
    }
    if (view.status === 'completed') {
      return { ...base, status: 'completed', ...(view.outcome ? { outcome: view.outcome } : {}) };
    }
    throw new Error(`Speakers run ${view.threadId} ended in an unexpected state: ${view.status}`);
  }
}
