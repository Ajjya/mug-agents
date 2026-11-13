import {
  type BaseCheckpointSaver,
  END,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import { DecisionValueSchema } from '../../approvals/approval.schema.js';
import { requireAutonomy } from '../../approvals/autonomy.js';
import { type PlanReviewPayload, assertEditAllowed } from '../../approvals/plan-review.payload.js';
import { newEntityId } from '../../domain/common.js';
import { buildPlanReviewPayload } from './review-payload.js';
import type { LlmCallRecord } from '../../llm/model.types.js';
import type { StructuredCall } from '../../llm/structured.js';
import {
  ChecklistOutputSchema,
  type ChecklistOutput,
  TimelineOutputSchema,
  type TimelineOutput,
} from './llm-schemas.js';
import { checklistPrompt, timelinePrompt } from './prompts.js';
import {
  EventBriefSchema,
  type EventBrief,
  type PlannerState,
  PlannerStateSchema,
} from './planner.state.js';
import { type Milestone, computeMilestones } from './timeline.js';

/** Everything the flow produces, before anything is persisted. */
export interface PlanDraft {
  brief: EventBrief;
  milestones: Milestone[];
  timeline: TimelineOutput;
  checklist: ChecklistOutput;
  calls: LlmCallRecord[];
}

export interface PlanRunOptions {
  /** Ladder index to start at (evals pin a rung). */
  startAt?: number;
  now?: Date;
}

/** What the service depends on; tests stub it with a canned draft. */
export interface PlannerGraph {
  run(brief: EventBrief, options?: PlanRunOptions): Promise<PlanDraft>;
}

// --- Node bodies: plain functions, unit-testable with a stubbed StructuredCall. ---------------

/** No model call. Validates the brief and computes milestone dates from the event date. */
export function normaliseBrief(state: PlannerState): Pick<PlannerState, 'brief' | 'milestones'> {
  const brief = EventBriefSchema.parse(state.brief);
  const now = state.nowIso ? new Date(state.nowIso) : new Date();
  return { brief, milestones: computeMilestones(brief.date, now) };
}

export async function generateTimeline(
  call: StructuredCall,
  state: PlannerState,
): Promise<Pick<PlannerState, 'timeline' | 'calls'>> {
  if (!state.brief || !state.milestones)
    throw new Error('generateTimeline ran before normaliseBrief');
  const r = await call(TimelineOutputSchema, timelinePrompt(state.brief, state.milestones), {
    node: 'generateTimeline',
    ...(state.startAt === undefined ? {} : { startAt: state.startAt }),
  });
  return { timeline: r.value, calls: r.calls };
}

export async function generateChecklist(
  call: StructuredCall,
  state: PlannerState,
): Promise<Pick<PlannerState, 'checklist' | 'calls'>> {
  if (!state.brief || !state.milestones || !state.timeline) {
    throw new Error('generateChecklist ran before generateTimeline');
  }
  const r = await call(
    ChecklistOutputSchema,
    checklistPrompt(state.brief, state.milestones, state.timeline),
    {
      node: 'generateChecklist',
      ...(state.startAt === undefined ? {} : { startAt: state.startAt }),
    },
  );
  return { checklist: r.value, calls: r.calls };
}

// --- The graph: normaliseBrief -> generateTimeline -> generateChecklist --------------------------

export function buildPlannerGraph(call: StructuredCall) {
  return new StateGraph(PlannerStateSchema)
    .addNode('normaliseBrief', (state) => normaliseBrief(state))
    .addNode('generateTimeline', (state) => generateTimeline(call, state))
    .addNode('generateChecklist', (state) => generateChecklist(call, state))
    .addEdge(START, 'normaliseBrief')
    .addEdge('normaliseBrief', 'generateTimeline')
    .addEdge('generateTimeline', 'generateChecklist')
    .addEdge('generateChecklist', END)
    .compile();
}

export class LangGraphPlanner implements PlannerGraph {
  private readonly graph: ReturnType<typeof buildPlannerGraph>;

  constructor(call: StructuredCall) {
    this.graph = buildPlannerGraph(call);
  }

  async run(brief: EventBrief, options: PlanRunOptions = {}): Promise<PlanDraft> {
    const out = await this.graph.invoke({
      brief,
      ...(options.now ? { nowIso: options.now.toISOString() } : {}),
      ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    });
    if (!out.brief || !out.milestones || !out.timeline || !out.checklist) {
      throw new Error('Planner graph finished without a complete plan'); // a bug, not a model failure
    }
    return {
      brief: out.brief,
      milestones: out.milestones,
      timeline: out.timeline,
      checklist: out.checklist,
      calls: out.calls,
    };
  }
}

// =============================================================================================
// M2: the same three nodes, then a human decision, then persistence.
//
//   normaliseBrief -> generateTimeline -> generateChecklist -> requestPlanApproval
//        -> persistPlan            (approve / edit)
//        -> recordRejection        (reject)
//
// LangGraph re-runs an interrupted node FROM ITS START when it resumes (verified on the installed
// version), so every node below is safe to run twice: a node with side effects either performs them
// idempotently or performs them after the interrupt.
// =============================================================================================

export interface EnsureRequestInput {
  threadId: string;
  runId: string;
  nodeName: string;
  eventId: string;
  payload: PlanReviewPayload;
}

/** Writes the ApprovalRequest. Must be idempotent per (threadId, runId, nodeName). */
export interface ApprovalGate {
  ensureRequest(input: EnsureRequestInput): Promise<{ id: string }>;
}

export interface PlanPersistencePort {
  insertTasks(
    eventId: string,
    checklist: ChecklistOutput,
    milestones: readonly Milestone[],
  ): Promise<{ created: readonly unknown[]; skipped: number }>;
  recordRejection(eventId: string, reason: string): Promise<void>;
}

export interface ApprovalGraphDeps {
  call: StructuredCall;
  gate: ApprovalGate;
  persistence: PlanPersistencePort;
}

export const NODE_REQUEST_APPROVAL = 'requestPlanApproval';

/**
 * First node of a run: validates, computes milestones, and starts a fresh run identity. Run-scoped
 * fields are reset so a re-plan on a reused thread never sees the previous run's answers.
 */
export function beginRun(state: PlannerState): Partial<PlannerState> {
  return {
    ...normaliseBrief(state),
    runId: newEntityId(),
    timeline: null,
    checklist: null,
    payload: null,
    decision: null,
    outcome: null,
    persisted: null,
  };
}

/**
 * Builds the review payload, writes the ApprovalRequest (idempotently), then suspends.
 * On resume this function runs again from the top: building the payload is pure, ensureRequest finds
 * the request it already wrote, and interrupt() returns the human's decision instead of suspending.
 */
export async function requestPlanApproval(
  deps: ApprovalGraphDeps,
  state: PlannerState,
  config: LangGraphRunnableConfig,
): Promise<Partial<PlannerState>> {
  if (
    !state.brief ||
    !state.milestones ||
    !state.timeline ||
    !state.checklist ||
    !state.eventId ||
    !state.runId
  ) {
    throw new Error('requestPlanApproval ran before the plan was generated');
  }
  const payload = buildPlanReviewPayload({
    eventId: state.eventId,
    theme: state.brief.theme,
    milestones: state.milestones,
    timeline: state.timeline,
    checklist: state.checklist,
  });
  // The policy table decides whether a human is needed; neither this node nor the model does.
  if (requireAutonomy('plan_review') === 'auto')
    return { payload, decision: { decision: 'approve' } };

  const threadId: unknown = config.configurable?.['thread_id'];
  if (typeof threadId !== 'string') throw new Error('requestPlanApproval needs a thread_id');
  // Written BEFORE interrupt(): a crash between the two leaves a pending request whose thread is
  // not suspended (an "orphan", flagged by `approvals list`); resuming the thread re-runs this node.
  await deps.gate.ensureRequest({
    threadId,
    runId: state.runId,
    nodeName: NODE_REQUEST_APPROVAL,
    eventId: state.eventId,
    payload,
  });
  const answer = interrupt<PlanReviewPayload, unknown>(payload, {
    responseSchema: DecisionValueSchema,
  });
  return { payload, decision: DecisionValueSchema.parse(answer) };
}

/** Persists the approved (or edited) checklist. Due dates come from the code-computed milestones. */
export async function persistPlan(
  deps: ApprovalGraphDeps,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  requireAutonomy('create_task');
  if (!state.eventId || !state.milestones || !state.payload || !state.decision) {
    throw new Error('persistPlan ran before a decision was made');
  }
  const decision = state.decision;
  if (decision.decision === 'reject')
    throw new Error('persistPlan must not run for a rejected plan');
  let effective = state.payload;
  if (decision.decision === 'edit') {
    // Defence in depth: the approvals service already checked this before resuming.
    assertEditAllowed(state.payload, decision.editedPayload);
    effective = decision.editedPayload;
  }
  const checklist: ChecklistOutput = {
    tasks: effective.checklist.map((t) => ({
      milestone: t.milestone,
      title: t.title,
      owner: t.owner,
    })),
  };
  const result = await deps.persistence.insertTasks(state.eventId, checklist, state.milestones);
  return {
    outcome: 'persisted',
    persisted: { created: result.created.length, skipped: result.skipped },
  };
}

/** Terminates a rejected run: records the reason on the event; persists nothing from the proposal. */
export async function recordRejection(
  deps: ApprovalGraphDeps,
  state: PlannerState,
): Promise<Partial<PlannerState>> {
  if (!state.eventId || state.decision?.decision !== 'reject') {
    throw new Error('recordRejection ran without a rejection');
  }
  await deps.persistence.recordRejection(state.eventId, state.decision.reason);
  return { outcome: 'rejected', persisted: { created: 0, skipped: 0 } };
}

export function buildApprovalGraph(deps: ApprovalGraphDeps, checkpointer: BaseCheckpointSaver) {
  return new StateGraph(PlannerStateSchema)
    .addNode('normaliseBrief', (state) => beginRun(state))
    .addNode('generateTimeline', (state) => generateTimeline(deps.call, state))
    .addNode('generateChecklist', (state) => generateChecklist(deps.call, state))
    .addNode(NODE_REQUEST_APPROVAL, (state, config) => requestPlanApproval(deps, state, config))
    .addNode('persistPlan', (state) => persistPlan(deps, state))
    .addNode('recordRejection', (state) => recordRejection(deps, state))
    .addEdge(START, 'normaliseBrief')
    .addEdge('normaliseBrief', 'generateTimeline')
    .addEdge('generateTimeline', 'generateChecklist')
    .addEdge('generateChecklist', NODE_REQUEST_APPROVAL)
    .addConditionalEdges(
      NODE_REQUEST_APPROVAL,
      (state) => (state.decision?.decision === 'reject' ? 'recordRejection' : 'persistPlan'),
      ['persistPlan', 'recordRejection'],
    )
    .addEdge('persistPlan', END)
    .addEdge('recordRejection', END)
    .compile({ checkpointer });
}

export type ApprovalGraph = ReturnType<typeof buildApprovalGraph>;
