import type { PlanReviewPayload } from '../../approvals/plan-review.payload.js';
import { PlanReviewPayloadSchema } from '../../approvals/plan-review.payload.js';
import { GraphRuntime, type RetentionPort, type ThreadView } from '../../graph/runtime.js';
import type { ThreadLock } from '../../graph/thread-lock.js';
import { NODE_REQUEST_APPROVAL, type ApprovalGraph } from './planner.graph.js';
import type { EventBrief } from './planner.state.js';

export type { RetentionPort, ThreadStatus } from '../../graph/runtime.js';
export type PlanThreadView = ThreadView<PlanReviewPayload>;
/** Kept for the planner's callers: a thread view whose review is a plan. */
export type { PlanThreadView as ThreadView };

export interface StartInput {
  brief: EventBrief;
  eventId: string;
  now?: Date;
  startAt?: number;
}

/** The planner's runtime: the generic one, plus a typed start. */
export class PlannerRuntime extends GraphRuntime<PlanReviewPayload> {
  constructor(graph: ApprovalGraph, retention: RetentionPort, lock: ThreadLock) {
    super(graph, retention, lock, {
      purpose: 'plan',
      approvalNode: NODE_REQUEST_APPROVAL,
      reviewSchema: PlanReviewPayloadSchema,
    });
  }

  async start(threadId: string, input: StartInput): Promise<PlanThreadView> {
    return await this.startWith(threadId, {
      brief: input.brief,
      eventId: input.eventId,
      // Always written, null when absent: these are per-run inputs, and a reused thread must not
      // inherit the previous run's ladder rung or "today" from its checkpoint.
      nowIso: input.now ? input.now.toISOString() : null,
      startAt: input.startAt ?? null,
    });
  }
}
