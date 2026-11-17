import { Command } from '@langchain/langgraph';
import type { z } from 'zod';
import type { LlmCallRecord } from '../llm/model.types.js';
import { type ThreadLock, withLock } from './thread-lock.js';
import { type ThreadPurpose, parseThreadId } from './thread.js';

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

export interface ThreadView<R = unknown> {
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
  /** What the human was shown (the interrupt payload), once the run got that far. */
  review?: R;
  calls: LlmCallRecord[];
  /** Set by inFlight(): another process holds the thread's lease right now. */
  running?: boolean;
}

export interface RetentionPort {
  scheduleExpiry(threadId: string): Promise<unknown>;
  cancelExpiry(threadId: string): Promise<void>;
  inFlightThreadIds(): Promise<string[]>;
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

/** The two calls the runtime makes on a compiled graph (method syntax: any compiled graph fits). */
export interface RunnableGraph {
  invoke(input: unknown, config: { configurable: { thread_id: string } }): Promise<unknown>;
  getState(config: { configurable: { thread_id: string } }): Promise<{
    values: unknown;
    next: readonly string[];
    createdAt?: string | undefined;
    tasks: readonly {
      name: string;
      error?: unknown;
      interrupts: readonly { value?: unknown }[];
    }[];
  }>;
}

export interface GraphRuntimeOptions<R> {
  /** The thread purpose this runtime owns (`event:<id>:<purpose>`). */
  purpose: ThreadPurpose;
  /** The node that writes the ApprovalRequest and suspends. */
  approvalNode: string;
  /** Validates what the human is shown (the interrupt payload, or `payload` in state). */
  reviewSchema: z.ZodType<R>;
}

/**
 * The only code that talks to a compiled approval graph: start, resume with a decision, continue
 * after a failure, and look at a thread. A thread that ends is stamped for expiry; a thread that is
 * paused or failed is left alone, so it stays resumable. One per thread purpose (plan, speakers).
 */
export class GraphRuntime<R = unknown> {
  readonly purpose: ThreadPurpose;
  readonly approvalNode: string;
  private readonly reviewSchema: z.ZodType<R>;

  constructor(
    private readonly graph: RunnableGraph,
    private readonly retention: RetentionPort,
    /** One run per thread at a time, across processes. */
    readonly lock: ThreadLock,
    options: GraphRuntimeOptions<R>,
  ) {
    this.purpose = options.purpose;
    this.approvalNode = options.approvalNode;
    this.reviewSchema = options.reviewSchema;
  }

  /** The thread's current state values (whatever the graph's state schema holds). */
  async values(threadId: string): Promise<unknown> {
    return (await this.graph.getState(cfg(threadId))).values;
  }

  /** Whether a thread id belongs to this runtime. */
  owns(threadId: string): boolean {
    const parsed = parseThreadId(threadId);
    return parsed.ok && parsed.value.purpose === this.purpose;
  }

  async inspect(threadId: string): Promise<ThreadView<R>> {
    const snapshot = await this.graph.getState(cfg(threadId));
    const values = snapshot.values as {
      runId?: string;
      eventId?: string;
      outcome?: 'persisted' | 'rejected' | null;
      persisted?: { created: number; skipped: number } | null;
      calls?: LlmCallRecord[];
      payload?: unknown;
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
    const shown = this.reviewSchema.safeParse(interrupted?.interrupts[0]?.value ?? values.payload);
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

  /**
   * Starts a run with the graph's input. A completed thread being reused must not expire mid-run, so
   * its stamp is lifted first.
   */
  async startWith(threadId: string, input: Record<string, unknown>): Promise<ThreadView<R>> {
    if (!this.owns(threadId)) throw new RangeError(`${threadId} is not a ${this.purpose} thread`);
    return await withLock(this.lock, threadId, () => this.startLocked(threadId, input));
  }

  private async startLocked(
    threadId: string,
    input: Record<string, unknown>,
  ): Promise<ThreadView<R>> {
    await this.retention.cancelExpiry(threadId);
    try {
      await this.graph.invoke(input, cfg(threadId));
    } finally {
      // Even on failure: the thread keeps its state and is resumable (or, if it somehow finished, stamped).
      await this.settle(threadId);
    }
    return await this.inspect(threadId);
  }

  /** Resumes a suspended thread with a human decision. */
  async resume(threadId: string, decision: unknown): Promise<ThreadView<R>> {
    return await withLock(this.lock, threadId, () => this.resumeLocked(threadId, decision));
  }

  private async resumeLocked(threadId: string, decision: unknown): Promise<ThreadView<R>> {
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
  async continue(threadId: string): Promise<ThreadView<R>> {
    return await withLock(this.lock, threadId, () => this.continueLocked(threadId));
  }

  private async continueLocked(threadId: string): Promise<ThreadView<R>> {
    try {
      await this.graph.invoke(null, cfg(threadId));
    } finally {
      await this.settle(threadId);
    }
    return await this.inspect(threadId);
  }

  /** This purpose's threads that have not completed: suspended, failed or orphaned. */
  async inFlight(): Promise<ThreadView<R>[]> {
    const ids = (await this.retention.inFlightThreadIds()).filter((id) => this.owns(id));
    return await Promise.all(
      ids.map(async (id) => ({ ...(await this.inspect(id)), running: await this.lock.isHeld(id) })),
    );
  }

  private async settle(threadId: string): Promise<void> {
    const view = await this.inspect(threadId);
    if (view.status === 'completed') await this.retention.scheduleExpiry(threadId);
  }
}
