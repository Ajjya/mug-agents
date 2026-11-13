import type { PlanDraft } from '../src/agents/planner/planner.graph.js';
import type { PlanStartResult } from '../src/agents/planner/planner.service.js';
import type { StructuredCall } from '../src/llm/structured.js';
import type { AssertionResult } from './assertions.js';
import { buildEvalServices } from './services.js';

export const PERSIST_IDEMPOTENT = 'persist-is-idempotent-for-the-same-draft';
export const ENSURE_PLANNED_IDEMPOTENT = 'ensure-planned-is-idempotent-for-the-same-brief';

/** What happened across two calls; evaluated by pure functions so the checks can be tested to fail. */
export interface PersistObservation {
  firstCreated: number;
  secondCreated: number;
  totalAfterFirst: number;
  totalAfterSecond: number;
}

export function evaluatePersist(o: PersistObservation): AssertionResult {
  const pass =
    o.secondCreated === 0 &&
    o.totalAfterSecond === o.totalAfterFirst &&
    o.firstCreated === o.totalAfterFirst;
  return {
    name: PERSIST_IDEMPOTENT,
    pass,
    ...(pass
      ? {}
      : {
          detail: `first persist created ${String(o.firstCreated)}, second ${String(o.secondCreated)}, total ${String(o.totalAfterFirst)} -> ${String(o.totalAfterSecond)}`,
        }),
  };
}

export interface EnsurePlannedObservation {
  /** The first call must pause for approval; after approving, the second must say already_planned. */
  firstStatus: PlanStartResult['status'];
  secondStatus: PlanStartResult['status'];
  /** Model calls across both start calls: exactly one run's worth, none for the second call. */
  modelCalls: number;
  expectedModelCalls: number;
  totalAfterFirst: number;
  totalAfterSecond: number;
}

export function evaluateEnsurePlanned(o: EnsurePlannedObservation): AssertionResult {
  const problems: string[] = [];
  if (o.firstStatus !== 'awaiting_approval')
    problems.push(`first call returned '${o.firstStatus}'`);
  if (o.secondStatus !== 'already_planned')
    problems.push(`second call returned '${o.secondStatus}'`);
  if (o.modelCalls !== o.expectedModelCalls) {
    problems.push(
      `model ran ${String(o.modelCalls)} times (expected ${String(o.expectedModelCalls)})`,
    );
  }
  if (o.totalAfterSecond !== o.totalAfterFirst) {
    problems.push(`tasks ${String(o.totalAfterFirst)} -> ${String(o.totalAfterSecond)}`);
  }
  return {
    name: ENSURE_PLANNED_IDEMPOTENT,
    pass: problems.length === 0,
    ...(problems.length === 0 ? {} : { detail: problems.join('; ') }),
  };
}

/** Replays the finished draft's model answers: a stand-in for the model that counts how often it is asked. */
function replayCall(draft: PlanDraft, counter: { n: number }): StructuredCall {
  return (_schema, _prompt, options) => {
    counter.n++;
    const value = options.node === 'generateTimeline' ? draft.timeline : draft.checklist;
    return Promise.resolve({
      value: value as never,
      calls: [],
      model: { provider: 'ollama', model: 'replay' },
    });
  };
}

/**
 * Two idempotency checks on the draft a model produced, without spending another model call:
 *  1. persisting the same draft twice adds nothing;
 *  2. planning the same brief twice: the first call pauses for approval, a human approves, and the
 *     second call must answer 'already_planned' without reaching the model. The model is replaced by
 *     a replay of the draft, because what is under test is the service's decision not to call it.
 */
export async function idempotencyAssertions(
  draft: PlanDraft,
  rawBrief: unknown,
  now: Date,
): Promise<AssertionResult[]> {
  const a = buildEvalServices(replayCall(draft, { n: 0 }));
  const { event } = await a.persistence.upsertEvent(draft.brief);
  const first = await a.persistence.insertTasks(event._id, draft.checklist, draft.milestones);
  const totalAfterFirst = await a.tasks.count();
  const second = await a.persistence.insertTasks(event._id, draft.checklist, draft.milestones);
  const persist = evaluatePersist({
    firstCreated: first.created.length,
    secondCreated: second.created.length,
    totalAfterFirst,
    totalAfterSecond: await a.tasks.count(),
  });

  const counter = { n: 0 };
  const b = buildEvalServices(replayCall(draft, counter));
  const one = await b.planner.startPlan(rawBrief, { now });
  if (one.status === 'awaiting_approval' && one.requestId) {
    await b.approvals.decide(one.requestId, { decision: 'approve' }, 'eval', now);
  }
  const afterOne = await b.tasks.count();
  const two = await b.planner.startPlan(rawBrief, { now });
  const ensure = evaluateEnsurePlanned({
    firstStatus: one.status,
    secondStatus: two.status,
    modelCalls: counter.n,
    expectedModelCalls: 2, // one run = the timeline node + the checklist node
    totalAfterFirst: afterOne,
    totalAfterSecond: await b.tasks.count(),
  });
  return [persist, ensure];
}
