import { Inject, Injectable, Logger } from '@nestjs/common';
import { PLANNER_RUNTIME } from '../../approvals/approvals.service.js';
import {
  APPROVAL_REQUESTS_REPOSITORY,
  type ApprovalRequestsRepository,
} from '../../approvals/approvals.repository.js';
import type { PlanReviewPayload } from '../../approvals/plan-review.payload.js';
import type { Event } from '../../domain/event.schema.js';
import { withLock } from '../../graph/thread-lock.js';
import { threadIdFor } from '../../graph/thread.js';
import { ProviderUnavailableError, StructuredOutputError } from '../../llm/errors.js';
import type { LlmCallRecord } from '../../llm/model.types.js';
import { NODE_REQUEST_APPROVAL } from './planner.graph.js';
import { PlanPersistence } from './plan-persistence.js';
import type { PlannerRuntime, ThreadView } from './planner.runtime.js';
import { EventBriefSchema, type EventBrief } from './planner.state.js';
import { computeMilestones } from './timeline.js';

export const PLAN_PERSISTENCE = Symbol('PLAN_PERSISTENCE');

/** Lock key for starting a plan from a brief: the event id if given, else its natural key. */
function planKey(brief: EventBrief): string {
  return brief.eventId
    ? `plan-start:event:${brief.eventId.toLowerCase()}`
    : `plan-start:${brief.date.slice(0, 10)}:${brief.theme.trim().toLowerCase()}`;
}

export class InvalidBriefError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid event brief:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'InvalidBriefError';
  }
}

/**
 * A run stopped because the provider or the model failed. The thread keeps its state at the last
 * completed node: nothing was lost, and `approvals resume <threadId>` re-runs only what failed.
 * `cause` says which kind of failure it was; the two are never mixed.
 */
export class PlanRunInterruptedError extends Error {
  constructor(
    public readonly threadId: string,
    public override readonly cause: ProviderUnavailableError | StructuredOutputError,
  ) {
    super(
      `${cause instanceof ProviderUnavailableError ? 'Provider failure' : 'Model failure'} in plan run ${threadId}: ${cause.message}. ` +
        `The run is resumable: npm run approvals -- resume ${threadId}`,
    );
    this.name = 'PlanRunInterruptedError';
  }
}

export interface PlanStartOptions {
  now?: Date;
  /** Ladder index the model nodes start at. */
  startAt?: number;
  /** Plan again even if the event already has agent-created tasks (only new titles are added). */
  replan?: boolean;
}

export type PlanStartResult =
  | {
      /** Suspended at the approval point. Nothing is persisted until a human decides. */
      status: 'awaiting_approval';
      event: Event;
      threadId: string;
      requestId: string | undefined;
      /** True when a thread was already waiting: it is continued, no second run is started. */
      alreadyWaiting: boolean;
      review: PlanReviewPayload | undefined;
      calls: LlmCallRecord[];
    }
  | {
      /** Ran to the end in this call (only when the policy table says plan_review is `auto`). */
      status: 'completed';
      event: Event;
      threadId: string;
      outcome: 'persisted' | 'rejected';
      created: number;
      skipped: number;
      calls: LlmCallRecord[];
    }
  | {
      /** The event already has an agent-generated plan; no model was called, nothing was written. */
      status: 'already_planned';
      event: Event;
      existingTasks: number;
    };

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(
    @Inject(PLAN_PERSISTENCE) private readonly persistence: PlanPersistence,
    @Inject(PLANNER_RUNTIME) private readonly runtime: PlannerRuntime,
    @Inject(APPROVAL_REQUESTS_REPOSITORY) private readonly requests: ApprovalRequestsRepository,
  ) {}

  /** Validates the brief. Never touches a model or the database. */
  parseBrief(input: unknown): EventBrief {
    const parsed = EventBriefSchema.safeParse(input);
    if (parsed.success) return parsed.data;
    throw new InvalidBriefError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  /**
   * Plans an event, pausing for a human decision. Thread identity is deterministic
   * (`event:<eventId>:plan`), so a second call for the same event can only ever continue the same
   * thread, never fork a parallel one:
   *  - thread waiting for a decision  -> reported as waiting; no model call;
   *  - thread stopped by a failure    -> continued: only the failed node runs again;
   *  - thread finished, tasks exist   -> already_planned (unless `replan`);
   *  - otherwise                      -> a new run on that thread.
   * A past date or an invalid brief is rejected before any lookup or model call. The event is
   * created/updated only when a new run starts (it is what the thread hangs off); the paths that
   * start nothing leave it untouched. Concurrent calls are serialised by a cross-process lease.
   */
  async startPlan(input: unknown, options: PlanStartOptions = {}): Promise<PlanStartResult> {
    const brief = this.parseBrief(input);
    computeMilestones(brief.date, options.now ?? new Date());
    // Serialise "resolve the event, then start its thread" for the same brief across processes, so
    // two concurrent calls cannot both create the event or both start a run.
    return await withLock(this.runtime.lock, planKey(brief), () =>
      this.startLocked(brief, options),
    );
  }

  private async startLocked(
    brief: EventBrief,
    options: PlanStartOptions,
  ): Promise<PlanStartResult> {
    // Look before writing: the paths that start nothing must not touch the event either.
    const existing = await this.persistence.findEvent(brief);
    let callsBefore = 0;
    if (existing) {
      const threadId = threadIdFor(existing._id, 'plan');
      const before = await this.runtime.inspect(threadId);
      callsBefore = before.calls.length;
      if (before.status === 'awaiting_decision') {
        this.logger.log(`event ${existing._id} already has a plan waiting for a decision`);
        return await this.result(existing, before, 0, true);
      }
      if (before.status === 'resumable') {
        // The stopped run continues with the brief it started with (kept in its checkpoint).
        this.logger.log(
          `event ${existing._id}: continuing stopped thread at ${before.failedNode ?? '?'}`,
        );
        const view = await this.guard(threadId, () => this.runtime.continue(threadId));
        return await this.result(existing, view, callsBefore, true);
      }
      if (!options.replan) {
        const existingTasks = await this.persistence.agentTaskCount(existing._id);
        if (existingTasks > 0) return { status: 'already_planned', event: existing, existingTasks };
      }
    }
    // A new run starts: only now is the event created or brought up to date with the brief.
    const { event } = await this.persistence.upsertEvent(brief);
    const threadId = threadIdFor(event._id, 'plan');
    const view = await this.guard(threadId, () =>
      this.runtime.start(threadId, {
        brief,
        eventId: event._id,
        ...(options.now ? { now: options.now } : {}),
        ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
      }),
    );
    return await this.result(event, view, callsBefore, false);
  }

  private async guard(threadId: string, run: () => Promise<ThreadView>): Promise<ThreadView> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ProviderUnavailableError || err instanceof StructuredOutputError) {
        throw new PlanRunInterruptedError(threadId, err);
      }
      throw err;
    }
  }

  private async result(
    event: Event,
    view: ThreadView,
    callsBefore: number,
    alreadyWaiting: boolean,
  ): Promise<PlanStartResult> {
    const calls = view.calls.slice(callsBefore);
    if (view.status === 'awaiting_decision') {
      const request =
        view.runId === undefined
          ? null
          : await this.requests.findByKey(view.threadId, view.runId, NODE_REQUEST_APPROVAL);
      return {
        status: 'awaiting_approval',
        event,
        threadId: view.threadId,
        requestId: request?._id,
        alreadyWaiting,
        review: view.review,
        calls,
      };
    }
    if (view.status === 'completed' && view.outcome) {
      return {
        status: 'completed',
        event,
        threadId: view.threadId,
        outcome: view.outcome,
        created: view.persisted?.created ?? 0,
        skipped: view.persisted?.skipped ?? 0,
        calls,
      };
    }
    throw new Error(`Plan run ${view.threadId} ended in an unexpected state: ${view.status}`);
  }
}
