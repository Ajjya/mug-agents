import type { PlanDraft, PlannerGraph } from '../src/agents/planner/planner.graph.js';
import { PlannerService, type PlanOutcome } from '../src/agents/planner/planner.service.js';
import {
  InMemoryEventsRepository,
  InMemoryTasksRepository,
} from '../test/support/in-memory.repositories.js';
import type { AssertionResult } from './assertions.js';

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
  firstStatus: PlanOutcome['status'];
  secondStatus: PlanOutcome['status'];
  /** Times the graph (the model) ran across both calls. */
  modelRuns: number;
  totalAfterFirst: number;
  totalAfterSecond: number;
}

export function evaluateEnsurePlanned(o: EnsurePlannedObservation): AssertionResult {
  const problems: string[] = [];
  if (o.firstStatus !== 'planned') problems.push(`first call returned '${o.firstStatus}'`);
  if (o.secondStatus !== 'already_planned')
    problems.push(`second call returned '${o.secondStatus}'`);
  if (o.modelRuns !== 1) problems.push(`model ran ${String(o.modelRuns)} times (expected 1)`);
  if (o.totalAfterSecond !== o.totalAfterFirst) {
    problems.push(`tasks ${String(o.totalAfterFirst)} -> ${String(o.totalAfterSecond)}`);
  }
  return {
    name: ENSURE_PLANNED_IDEMPOTENT,
    pass: problems.length === 0,
    ...(problems.length === 0 ? {} : { detail: problems.join('; ') }),
  };
}

/** Replays one finished draft and counts how often it is asked for: a stand-in for the model. */
class ReplayGraph implements PlannerGraph {
  runs = 0;
  constructor(private readonly draft: PlanDraft) {}
  run(brief: PlanDraft['brief']): Promise<PlanDraft> {
    this.runs++;
    return Promise.resolve({ ...this.draft, brief });
  }
}

function freshService(graph: PlannerGraph) {
  const events = new InMemoryEventsRepository();
  const tasks = new InMemoryTasksRepository();
  return { service: new PlannerService(graph, events, tasks), tasks };
}

/**
 * Two idempotency checks on the draft a model produced, without spending another model call:
 *  1. persisting the same draft twice adds nothing;
 *  2. ensurePlanned on the same brief twice: the second call must answer 'already_planned' and must
 *     not reach the model. The model is replaced by a replay of the draft, because what is under
 *     test is the service's decision not to call it.
 */
export async function idempotencyAssertions(
  draft: PlanDraft,
  rawBrief: unknown,
  now: Date,
): Promise<AssertionResult[]> {
  const a = freshService(new ReplayGraph(draft));
  const first = await a.service.persist(draft);
  const totalAfterFirst = await a.tasks.count();
  const second = await a.service.persist(draft);
  const persist = evaluatePersist({
    firstCreated: first.created.length,
    secondCreated: second.created.length,
    totalAfterFirst,
    totalAfterSecond: await a.tasks.count(),
  });

  const replay = new ReplayGraph(draft);
  const b = freshService(replay);
  const one = await b.service.ensurePlanned(rawBrief, { now });
  const afterOne = await b.tasks.count();
  const two = await b.service.ensurePlanned(rawBrief, { now });
  const ensure = evaluateEnsurePlanned({
    firstStatus: one.status,
    secondStatus: two.status,
    modelRuns: replay.runs,
    totalAfterFirst: afterOne,
    totalAfterSecond: await b.tasks.count(),
  });
  return [persist, ensure];
}
