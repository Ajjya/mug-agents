import {
  type BaseCheckpointSaver,
  END,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import { registry } from '@langchain/langgraph/zod';
import { z } from 'zod';
import {
  DecisionValueSchema,
  type DecisionValue,
  isSpeakerReview,
} from '../../approvals/approval.schema.js';
import { requireAutonomy } from '../../approvals/autonomy.js';
import {
  type SpeakerReviewPayload,
  assertSpeakerEditAllowed,
  splitEdit,
} from '../../approvals/speaker-review.payload.js';
import { newEntityId } from '../../domain/common.js';
import type { Event } from '../../domain/event.schema.js';
import type { MessageKind } from '../../domain/message.schema.js';
import type { Speaker } from '../../domain/speaker.schema.js';
import type { LlmCallRecord } from '../../llm/model.types.js';
import type { StructuredCall } from '../../llm/structured.js';
import type { ChunkView } from '../../retrieval/vector-store.js';
import type { ApprovalGate } from '../planner/planner.graph.js';
import { needsApproval } from './autonomy.js';
import { type ChasePolicy, type Redraft, decideActions } from './decide.js';
import { type RoutedDecision, channelOf, outreachSuggestion, routeDelivery } from './delivery.js';
import { pipelineInput } from './pipeline.js';
import { buildFacts, draftPrompt, draftSchema, requiredSlots, substitute } from './drafting.js';
import type { DraftRecord, LoadedPipeline, SpeakerPipelineStore } from './speakers.store.js';

/**
 *   loadPipeline -> decideActions -> draftMessages -> persistDrafts -> requestApproval -> applyDecision
 *
 * Only draftMessages calls a model. Drafts are persisted BEFORE the approval point, all as `draft`:
 * auto drafts never wait for someone else's approval, and approval is what moves a first-contact
 * draft from `draft` to `approved`. LangGraph re-runs an interrupted node from its start, and every
 * write here is idempotent by natural key, so a resume (in any process) writes nothing twice.
 */

export const NODE_REQUEST_APPROVAL = 'requestApproval';

/** Retrieved context for one draft. Stubbed in tests; never a model, never a tool. */
export interface DraftContext {
  forDraft(event: Event, speaker: Speaker, kind: MessageKind): Promise<ChunkView[]>;
}

export interface SpeakersGraphDeps {
  call: StructuredCall;
  gate: ApprovalGate;
  store: SpeakerPipelineStore;
  context: DraftContext;
  policy: ChasePolicy;
  timeZone: string;
  /** When a recorded approval decision was made: a rejection's `rejectedAt` is this, nothing else. */
  decidedAt(requestId: string): Promise<string>;
}

const concat = <T>(a: T[], b: T[]): T[] => a.concat(b);

export const SpeakersStateSchema = z.object({
  eventId: z.string().optional(),
  /** Injected "today": a frozen clock in tests and evals. */
  nowIso: z.string().nullable().optional(),
  /** A human asked for a new round of a kind whose draft was rejected (`run --redraft`). */
  redraft: z.custom<Redraft[]>().nullable().optional(),
  runId: z.string().optional(),
  pipeline: z.custom<LoadedPipeline>().nullable().optional(),
  decision: z.custom<RoutedDecision>().nullable().optional(),
  drafts: z.custom<DraftRecord[]>().nullable().optional(),
  /** What persistDrafts did: ids it created, and the ones awaiting approval. */
  created: z.array(z.string()).nullable().optional(),
  existing: z.array(z.string()).nullable().optional(),
  toApprove: z.array(z.string()).nullable().optional(),
  tasksCreated: z.number().nullable().optional(),
  superseded: z.array(z.string()).nullable().optional(),
  approvalRequestId: z.string().nullable().optional(),
  payload: z.custom<SpeakerReviewPayload>().nullable().optional(),
  review: z.custom<DecisionValue>().nullable().optional(),
  outcome: z.enum(['persisted', 'rejected']).nullable().optional(),
  persisted: z.object({ created: z.number(), skipped: z.number() }).nullable().optional(),
  calls: z
    .custom<LlmCallRecord[]>()
    .default(() => [])
    .register(registry, { reducer: { fn: concat }, default: () => [] }),
});
export type SpeakersState = z.infer<typeof SpeakersStateSchema>;

const PENDING_STATUSES: readonly string[] = ['draft', 'approved'];

const nowOf = (state: SpeakersState): Date => (state.nowIso ? new Date(state.nowIso) : new Date());

// ---- nodes ------------------------------------------------------------------------------------

/** No model. Loads the event and its speakers, and starts a fresh run (run-scoped fields reset). */
export async function loadPipeline(
  deps: SpeakersGraphDeps,
  state: SpeakersState,
): Promise<Partial<SpeakersState>> {
  if (!state.eventId) throw new Error('loadPipeline needs an eventId');
  return {
    runId: newEntityId(),
    pipeline: await deps.store.load(state.eventId),
    decision: null,
    drafts: null,
    created: null,
    existing: null,
    toApprove: null,
    tasksCreated: null,
    superseded: null,
    approvalRequestId: null,
    payload: null,
    review: null,
    outcome: null,
    persisted: null,
  };
}

/** No model, no I/O: the pure decision function over what was loaded. */
export function decide(deps: SpeakersGraphDeps, state: SpeakersState): Partial<SpeakersState> {
  const p = state.pipeline;
  if (!p) throw new Error('decideActions ran before loadPipeline');
  return {
    // WHAT is due is decided with no draft cap and no idea of channels; HOW it is delivered (and the cap on
    // drafts) comes after, so a speaker nobody can reach cannot use up the cap.
    decision: routeDelivery(
      decideActions(
        pipelineInput(
          p,
          nowOf(state),
          { ...deps.policy, maxDraftsPerRun: Number.MAX_SAFE_INTEGER },
          state.redraft ?? [],
        ),
      ),
      p.speakers,
      deps.policy.maxDraftsPerRun,
    ),
  };
}

/** The only model calls: one per planned action, to word a message whose facts code decided. */
export async function draftMessages(
  deps: SpeakersGraphDeps,
  state: SpeakersState,
): Promise<Partial<SpeakersState>> {
  const p = state.pipeline;
  const d = state.decision;
  if (!p || !d) throw new Error('draftMessages ran before decideActions');
  const drafts: DraftRecord[] = [];
  const calls: LlmCallRecord[] = [];
  for (const action of d.actions) {
    const speaker = p.speakers.find((s) => s._id === action.speakerId);
    if (!speaker) throw new Error(`planned action for unknown speaker ${action.speakerId}`);
    const facts = buildFacts({
      event: p.event,
      speaker,
      venue: p.venue,
      kind: action.kind,
      now: nowOf(state),
      replyDays: deps.policy.chaseMinIntervalDays,
      timeZone: deps.timeZone,
    });
    const required = requiredSlots(action.kind, facts);
    const context = await deps.context.forDraft(p.event, speaker, action.kind);
    const r = await deps.call(
      draftSchema(required, facts),
      draftPrompt({
        kind: action.kind,
        facts,
        required,
        theme: p.event.theme,
        speakerTopics: speaker.topics,
        context,
        speakerId: speaker._id,
      }),
      { node: 'draftMessages' },
    );
    calls.push(...r.calls);
    // The recipient, kind and round come from the action; the facts from the event record.
    const filled = substitute(r.value, facts, required);
    drafts.push({
      eventId: p.event._id,
      speakerId: speaker._id,
      kind: action.kind,
      round: action.round,
      reason: action.reason,
      subject: filled.subject,
      body: filled.body,
      facts: filled.facts,
      needsApproval: needsApproval(action.kind),
      // The SAME text whatever the channel: a person pastes it into LinkedIn or WhatsApp.
      channel: channelOf(action.delivery) ?? 'email',
    });
  }
  return { drafts, calls };
}

/** Upserts drafts (status draft), supersedes stale ones, turns blocked items into tasks. Idempotent. */
export async function persistDrafts(
  deps: SpeakersGraphDeps,
  state: SpeakersState,
): Promise<Partial<SpeakersState>> {
  const p = state.pipeline;
  const d = state.decision;
  if (!p || !d || !state.drafts) throw new Error('persistDrafts ran before draftMessages');
  requireAutonomy('draft_speaker_message');
  const created: string[] = [];
  const existing: string[] = [];
  let tasksCreated = 0;
  for (const draft of state.drafts) {
    const r = await deps.store.upsertDraft(draft);
    (r.created ? created : existing).push(r.message._id);
    // A draft for a channel a person sends by hand comes with a task, so it cannot be forgotten.
    if (r.message.channel !== 'email' && PENDING_STATUSES.includes(r.message.status)) {
      const name = p.speakers.find((s) => s._id === draft.speakerId)?.name ?? draft.speakerId;
      if ((await deps.store.ensureSendTask(r.message, name)).created) tasksCreated++;
    }
  }
  const superseded: string[] = [];
  for (const s of d.supersede)
    if (await deps.store.supersede(s.messageId)) superseded.push(s.messageId);
  requireAutonomy('create_task');
  // Due, but nobody can be reached: one task to find contact details, and no draft at all.
  for (const nc of d.noContact) {
    const name = p.speakers.find((x) => x._id === nc.speakerId)?.name ?? nc.speakerId;
    if ((await deps.store.ensureFindContactTask(p.event._id, nc.speakerId, name)).created)
      tasksCreated++;
  }
  // The first message is yours: an `idea` speaker at T-6w is a TASK carrying a suggestion, never a draft.
  for (const o of d.outreach) {
    const sp = p.speakers.find((x) => x._id === o.speakerId);
    if (!sp) continue;
    const suggestion = outreachSuggestion(sp, p.event);
    if (
      (await deps.store.ensureOutreachTask(p.event._id, sp._id, sp.name, p.event.title, suggestion))
        .created
    )
      tasksCreated++;
  }
  for (const b of d.blocked) {
    const name = p.speakers.find((s) => s._id === b.speakerId)?.name ?? b.speakerId;
    if ((await deps.store.ensureBlockedTask(p.event._id, b, name)).created) tasksCreated++;
  }
  // Everything for this event still waiting for a human, including a draft an earlier run left.
  const toApprove = (await deps.store.eventMessages(p.event._id))
    .filter((m) => m.needsApproval && m.status === 'draft')
    .map((m) => m._id);
  return { created, existing, superseded, tasksCreated, toApprove };
}

/** Suspends for a human when a draft needs approval; otherwise passes straight through. */
export async function requestApproval(
  deps: SpeakersGraphDeps,
  state: SpeakersState,
  config: LangGraphRunnableConfig,
): Promise<Partial<SpeakersState>> {
  const p = state.pipeline;
  if (!p || !state.runId || !state.toApprove) throw new Error('requestApproval ran too early');
  if (state.toApprove.length === 0) return { payload: null, review: null };
  const all = await deps.store.eventMessages(p.event._id);
  const payload: SpeakerReviewPayload = {
    eventId: p.event._id,
    eventTitle: p.event.title,
    drafts: state.toApprove.flatMap((id) => {
      const m = all.find((x) => x._id === id);
      if (!m) return [];
      return [
        {
          messageId: m._id,
          speakerId: m.speakerId,
          speakerName: p.speakers.find((s) => s._id === m.speakerId)?.name ?? m.speakerId,
          kind: m.kind,
          round: m.round,
          reason: m.reason,
          subject: m.subject,
          body: m.body,
        },
      ];
    }),
  };
  const threadId: unknown = config.configurable?.['thread_id'];
  if (typeof threadId !== 'string') throw new Error('requestApproval needs a thread_id');
  const request = await deps.gate.ensureRequest({
    threadId,
    runId: state.runId,
    nodeName: NODE_REQUEST_APPROVAL,
    eventId: p.event._id,
    payload,
  });
  const answer = interrupt<SpeakerReviewPayload, unknown>(payload, {
    responseSchema: DecisionValueSchema,
  });
  return { payload, review: DecisionValueSchema.parse(answer), approvalRequestId: request.id };
}

/** approve: all approved. edit: kept approved, removed rejected. reject: all rejected. Idempotent. */
export async function applyDecision(
  deps: SpeakersGraphDeps,
  state: SpeakersState,
): Promise<Partial<SpeakersState>> {
  const created = state.created?.length ?? 0;
  const existing = state.existing?.length ?? 0;
  const done = { persisted: { created, skipped: existing } };
  const review = state.review;
  if (!review || !state.payload) return { outcome: 'persisted', ...done };
  const ids = state.payload.drafts.map((d) => d.messageId);
  const requestId = state.approvalRequestId ?? '';
  if (review.decision === 'reject') {
    const at = await deps.decidedAt(requestId);
    await deps.store.review(ids, { status: 'rejected', reason: review.reason, at });
    return { outcome: 'rejected', ...done };
  }
  if (review.decision === 'approve') {
    await deps.store.review(ids, { status: 'approved', approvalRequestId: requestId });
    return { outcome: 'persisted', ...done };
  }
  const edited = review.editedPayload;
  if (!isSpeakerReview(edited))
    throw new Error('applyDecision was resumed with a non-speaker edit');
  // Defence in depth: the approvals service already checked this before resuming.
  assertSpeakerEditAllowed(state.payload, edited);
  const { kept, removed } = splitEdit(state.payload, edited);
  await deps.store.review(kept, { status: 'approved', approvalRequestId: requestId });
  if (removed.length > 0) {
    const at = await deps.decidedAt(requestId);
    await deps.store.review(removed, { status: 'rejected', reason: 'removed at review', at });
  }
  return { outcome: 'persisted', ...done };
}

export function buildSpeakersGraph(deps: SpeakersGraphDeps, checkpointer: BaseCheckpointSaver) {
  return new StateGraph(SpeakersStateSchema)
    .addNode('loadPipeline', (s) => loadPipeline(deps, s))
    .addNode('decideActions', (s) => decide(deps, s))
    .addNode('draftMessages', (s) => draftMessages(deps, s))
    .addNode('persistDrafts', (s) => persistDrafts(deps, s))
    .addNode(NODE_REQUEST_APPROVAL, (s, config) => requestApproval(deps, s, config))
    .addNode('applyDecision', (s) => applyDecision(deps, s))
    .addEdge(START, 'loadPipeline')
    .addEdge('loadPipeline', 'decideActions')
    .addEdge('decideActions', 'draftMessages')
    .addEdge('draftMessages', 'persistDrafts')
    .addEdge('persistDrafts', NODE_REQUEST_APPROVAL)
    .addEdge(NODE_REQUEST_APPROVAL, 'applyDecision')
    .addEdge('applyDecision', END)
    .compile({ checkpointer });
}

export type SpeakersGraph = ReturnType<typeof buildSpeakersGraph>;
