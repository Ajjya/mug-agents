import { Command } from '@langchain/langgraph';
import type { DecisionValue } from '../../approvals/approval.schema.js';
import {
  PlanReviewPayloadSchema,
  type PlanReviewPayload,
} from '../../approvals/plan-review.payload.js';
import type { LlmCallRecord } from '../../llm/model.types.js';
import type { ApprovalGraph } from './planner.graph.js';
import type { EventBrief } from './planner.state.js';

/** Where a thread stands, read from its checkpoint. */
export type ThreadStatus =
  /** No checkpoint exists. */
  | 'none'
  /** Suspended at interrupt(): waiting for a human decision. */
  | 'awaiting_decision'
  /** Stopped with work left but not suspended: a node failed, or a crash happened before suspending. */
  | 'resumable'
  /** Ran to the end. */
  | 'completed';

export interface ThreadView {
  threadId: string;
  status: ThreadStatus;
  /** Nodes that would run next. */
  next: string[];
  /** For `resumable`: the node that failed (or that never suspended). */
  failedNode?: string;
  /** For `resumable`: the error's name and message when the checkpoint recorded one. */
  error?: string;
  runId?: string;
  eventId?: string;
  outcome?: 'persisted' | 'rejected';
  persisted?: { created: number; skipped: number };
  /** The plan the human was shown (the interrupt payload), once the run got that far. */
  review?: PlanReviewPayload;
  calls: LlmCallRecord[];
}

export interface RetentionPort {
  scheduleExpiry(threadId: string): Promise<unknown>;
  cancelExpiry(threadId: string): Promise<void>;
  inFlightThreadIds(): Promise<string[]>;
}

export interface StartInput {
  brief: EventBrief;
  eventId: string;
  now?: Date;
  startAt?: number;
}

const cfg = (threadId: string) => ({ configurable: { thread_id: threadId } });

const describeError = (error: unknown): string | undefined => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; message?: unknown };
    if (typeof e.message === 'string')
      return `${typeof e.name === 'string' ? e.name : 'Error'}: ${e.message}`;
  }
  return undefined;
};

/**
 * The only code that talks to the compiled graph: start, resume with a decision, continue after a
 * failure, and look at a thread. A thread that ends is stamped for expiry; a thread that is paused or
 * failed is left alone, so it stays resumable.
 */
export class PlannerRuntime {
  constructor(
    private readonly graph: ApprovalGraph,
    private readonly retention: RetentionPort,
  ) {}

  async inspect(threadId: string): Promise<ThreadView> {
    const snapshot = await this.graph.getState(cfg(threadId));
    const values = snapshot.values as {
      runId?: string;
      eventId?: string;
      outcome?: 'persisted' | 'rejected' | null;
      persisted?: { created: number; skipped: number } | null;
      calls?: LlmCallRecord[];
      payload?: PlanReviewPayload | null;
    };
    const next = [...snapshot.next];
    const base = {
      threadId,
      next,
      calls: values.calls ?? [],
      ...(values.runId ? { runId: values.runId } : {}),
      ...(values.eventId ? { eventId: values.eventId } : {}),
    };
    const interrupted = snapshot.tasks.find((t) => t.interrupts.length > 0);
    // While suspended the node has not committed its state, so the plan the human sees is the
    // interrupt value itself; once the run moved on it is in state.
    const shown = PlanReviewPayloadSchema.safeParse(
      interrupted?.interrupts[0]?.value ?? values.payload,
    );
    const review = shown.success ? { review: shown.data } : {};
    const exists = snapshot.createdAt !== undefined;
    if (!exists) return { ...base, status: 'none' };

    if (interrupted) {
      return {
        ...base,
        status: 'awaiting_decision',
        ...review,
      };
    }
    if (next.length > 0) {
      const failed = snapshot.tasks.find((t) => t.error !== undefined && t.error !== null);
      const error = failed ? describeError(failed.error) : undefined;
      return {
        ...base,
        status: 'resumable',
        failedNode: failed?.name ?? next[0] ?? 'unknown',
        ...(error ? { error } : {}),
        ...review,
      };
    }
    return {
      ...base,
      status: 'completed',
      ...review,
      ...(values.outcome ? { outcome: values.outcome } : {}),
      ...(values.persisted ? { persisted: values.persisted } : {}),
    };
  }

  /** Starts a run. A completed thread being reused must not expire mid-run, so its stamp is lifted first. */
  async start(threadId: string, input: StartInput): Promise<ThreadView> {
    await this.retention.cancelExpiry(threadId);
    try {
      await this.graph.invoke(
        {
          brief: input.brief,
          eventId: input.eventId,
          ...(input.now ? { nowIso: input.now.toISOString() } : {}),
          ...(input.startAt === undefined ? {} : { startAt: input.startAt }),
        },
        cfg(threadId),
      );
    } finally {
      // Even on failure: the thread keeps its state and is resumable (or, if it somehow finished, stamped).
      await this.settle(threadId);
    }
    return await this.inspect(threadId);
  }

  /** Resumes a suspended thread with a human decision. */
  async resume(threadId: string, decision: DecisionValue): Promise<ThreadView> {
    try {
      await this.graph.invoke(new Command({ resume: decision }), cfg(threadId));
    } finally {
      await this.settle(threadId);
    }
    return await this.inspect(threadId);
  }

  /**
   * Continues a thread that stopped without suspending (a failed node, or an orphaned approval
   * point). Only nodes that did not complete run again: completed nodes are not repeated.
   */
  async continue(threadId: string): Promise<ThreadView> {
    try {
      await this.graph.invoke(null, cfg(threadId));
    } finally {
      await this.settle(threadId);
    }
    return await this.inspect(threadId);
  }

  /** Threads that have not completed: suspended, failed or orphaned. */
  async inFlight(): Promise<ThreadView[]> {
    const ids = await this.retention.inFlightThreadIds();
    return await Promise.all(ids.map((id) => this.inspect(id)));
  }

  private async settle(threadId: string): Promise<void> {
    const view = await this.inspect(threadId);
    if (view.status === 'completed') await this.retention.scheduleExpiry(threadId);
  }
}
