import { Inject, Injectable, Logger } from '@nestjs/common';
import type { GraphRuntime, ThreadView } from '../graph/runtime.js';
import { allPages } from '../agents/planner/plan-persistence.js';
import { type EntityId, isEntityId } from '../domain/common.js';
import { parseThreadId } from '../graph/thread.js';
import { DuplicateKeyError, VersionConflictError } from '../repositories/base.repository.js';
import {
  type ApprovalDecision,
  type ApprovalPayload,
  type ApprovalRequest,
  type DecisionValue,
  DecisionValueSchema,
  isPlanReview,
  isSpeakerReview,
  payloadKind,
} from './approval.schema.js';
import {
  APPROVAL_DECISIONS_REPOSITORY,
  APPROVAL_REQUESTS_REPOSITORY,
  type ApprovalDecisionsRepository,
  type ApprovalRequestsRepository,
} from './approvals.repository.js';
import { InvalidEditError, assertEditAllowed } from './plan-review.payload.js';
import { assertSpeakerEditAllowed } from './speaker-review.payload.js';

export const PLANNER_RUNTIME = Symbol('PLANNER_RUNTIME');
/** Every approval graph's runtime, one per thread purpose. */
export const GRAPH_RUNTIMES = Symbol('GRAPH_RUNTIMES');

/** What the approvals workflow needs from a graph runtime (any purpose). */
export type ApprovalRuntime = Pick<
  GraphRuntime,
  'purpose' | 'approvalNode' | 'owns' | 'inspect' | 'resume' | 'continue' | 'inFlight'
>;

/**
 * An edit must be of the request's own kind, and within what that kind allows to change. Checked
 * before anything is recorded or resumed.
 */
export function assertEditMatches(original: ApprovalPayload, edited: ApprovalPayload): void {
  if (payloadKind(original) !== payloadKind(edited)) {
    throw new InvalidEditError([
      `the edited payload is a ${payloadKind(edited)}, the request is a ${payloadKind(original)}`,
    ]);
  }
  if (isPlanReview(original) && isPlanReview(edited)) assertEditAllowed(original, edited);
  if (isSpeakerReview(original) && isSpeakerReview(edited))
    assertSpeakerEditAllowed(original, edited);
}

export class ApprovalNotFoundError extends Error {
  constructor(public readonly requestId: string) {
    super(`No approval request with id ${requestId}`);
    this.name = 'ApprovalNotFoundError';
  }
}

/** Deciding twice is a bug, not a race to tolerate. */
export class ApprovalNotPendingError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly status: string,
  ) {
    super(`Approval request ${requestId} is already ${status}; a request can be decided only once`);
    this.name = 'ApprovalNotPendingError';
  }
}

/** The request is pending but its thread is not suspended (a crash between the write and the suspend). */
export class ApprovalOrphanError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly threadId: string,
  ) {
    super(
      `Approval request ${requestId} is an orphan: its thread is not waiting for a decision. ` +
        `Run "approvals resume ${threadId}" to repair it, then decide.`,
    );
    this.name = 'ApprovalOrphanError';
  }
}

export class ApprovalConflictError extends Error {
  constructor(requestId: string) {
    super(`A different decision is already recorded for approval request ${requestId}`);
    this.name = 'ApprovalConflictError';
  }
}

export interface PendingRow {
  request: ApprovalRequest;
  thread: ThreadView;
  /** Pending, but the thread is not suspended on this request: not actionable until repaired. */
  orphan: boolean;
  ageMs: number;
}

export interface Listing {
  pending: PendingRow[];
  /** Threads that stopped with work left and are not waiting on a human (failed nodes, orphans). */
  resumable: ThreadView[];
  /** Threads being run by some process right now. */
  running: ThreadView[];
}

export interface DecideResult {
  request: ApprovalRequest;
  decision: ApprovalDecision;
  thread: ThreadView;
}

export type ResumeResult =
  | { status: 'resumed'; thread: ThreadView }
  | { status: 'awaiting_decision'; thread: ThreadView; requestId?: string }
  | { status: 'already_completed'; thread: ThreadView }
  | { status: 'no_checkpoint'; threadId: string; expired: number };

const toValue = (d: ApprovalDecision): DecisionValue => {
  switch (d.decision) {
    case 'approve':
      return { decision: 'approve' };
    case 'edit':
      return DecisionValueSchema.parse({ decision: 'edit', editedPayload: d.editedPayload });
    case 'reject':
      return DecisionValueSchema.parse({ decision: 'reject', reason: d.reason });
  }
};

/** Structural equality of two decision values (key order independent). */
function sameDecision(a: DecisionValue, b: DecisionValue): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, val]) => [k, canonical(val)]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @Inject(APPROVAL_REQUESTS_REPOSITORY) private readonly requests: ApprovalRequestsRepository,
    @Inject(APPROVAL_DECISIONS_REPOSITORY) private readonly decisions: ApprovalDecisionsRepository,
    @Inject(GRAPH_RUNTIMES) private readonly runtimes: readonly ApprovalRuntime[],
  ) {}

  /** The runtime that owns a thread, by its purpose. */
  private runtimeFor(threadId: string): ApprovalRuntime {
    const runtime = this.runtimes.find((r) => r.owns(threadId));
    if (!runtime) throw new RangeError(`No approval graph handles thread ${threadId}`);
    return runtime;
  }

  async list(now: Date = new Date()): Promise<Listing> {
    const requests = await allPages((after) =>
      this.requests.findByStatus('pending', { limit: 200, ...(after ? { after } : {}) }),
    );
    const pending = await Promise.all(
      requests.map(async (request): Promise<PendingRow> => {
        const thread = await this.runtimeFor(request.threadId).inspect(request.threadId);
        const suspendedOnThis =
          thread.status === 'awaiting_decision' && thread.runId === request.runId;
        return {
          request,
          thread,
          orphan: !suspendedOnThis,
          ageMs: now.getTime() - new Date(request.createdAt).getTime(),
        };
      }),
    );
    const inFlight = (await Promise.all(this.runtimes.map((r) => r.inFlight()))).flat();
    return {
      pending,
      // A thread another process is running right now is not stopped, so it is not offered for resume.
      resumable: inFlight.filter((t) => t.status === 'resumable' && t.running !== true),
      running: inFlight.filter((t) => t.running === true),
    };
  }

  async show(
    requestId: EntityId,
  ): Promise<{ request: ApprovalRequest; thread: ThreadView; decision: ApprovalDecision | null }> {
    const request = await this.mustFind(requestId);
    return {
      request,
      thread: await this.runtimeFor(request.threadId).inspect(request.threadId),
      decision: await this.decisions.findByRequestId(request._id),
    };
  }

  /**
   * Records a decision and resumes the run. Order: validate everything first (an invalid edit never
   * reaches a node), record the decision, mark the request decided, then resume. If the process dies
   * after the request is marked decided but before the graph resumed, `resumeThread` finishes the job
   * from the recorded decision.
   */
  async decide(
    requestId: EntityId,
    value: DecisionValue,
    decidedBy: string,
    now: Date = new Date(),
  ): Promise<DecideResult> {
    const request = await this.mustFind(requestId);
    if (request.status !== 'pending')
      throw new ApprovalNotPendingError(request._id, request.status);

    const parsed = DecisionValueSchema.parse(value);
    if (parsed.decision === 'edit') assertEditMatches(request.payload, parsed.editedPayload);

    const runtime = this.runtimeFor(request.threadId);
    const before = await runtime.inspect(request.threadId);
    if (before.status !== 'awaiting_decision' || before.runId !== request.runId) {
      throw new ApprovalOrphanError(request._id, request.threadId);
    }

    const decision = await this.recordDecision(request, parsed, decidedBy, now);
    const decided = await this.markDecided(request, now);
    this.logger.log(
      `approval ${request._id} ${parsed.decision} by ${decidedBy}; resuming ${request.threadId}`,
    );
    // Resume with exactly what is on record.
    const thread = await runtime.resume(request.threadId, toValue(decision));
    return { request: decided, decision, thread };
  }

  /**
   * Gets a stalled thread moving again, whatever stalled it: a node that failed (continue), a crash
   * before the approval point suspended (continue: the node reuses its request), or a decision that
   * was recorded but never delivered (resume with it).
   */
  async resumeThread(threadId: string): Promise<ResumeResult> {
    const parsed = parseThreadId(threadId);
    if (!parsed.ok) throw new RangeError(parsed.error);
    const runtime = this.runtimeFor(threadId);
    const thread = await runtime.inspect(threadId);

    if (thread.status === 'none') {
      const stale = await allPages((after) =>
        this.requests.findByThread(threadId, { limit: 200, ...(after ? { after } : {}) }),
      );
      let expired = 0;
      for (const r of stale.filter((x) => x.status === 'pending')) {
        await this.requests.updateWithRetry(r._id, () => ({ status: 'expired' as const }));
        expired++;
      }
      return { status: 'no_checkpoint', threadId, expired };
    }
    if (thread.status === 'completed') return { status: 'already_completed', thread };

    if (thread.status === 'awaiting_decision') {
      const request = thread.runId
        ? await this.requests.findByKey(threadId, thread.runId, runtime.approvalNode)
        : null;
      const recorded = request ? await this.decisions.findByRequestId(request._id) : null;
      if (request && recorded) {
        // Decided but never delivered to the graph: deliver it now.
        if (request.status === 'pending')
          await this.markDecided(request, new Date(recorded.decidedAt));
        return {
          status: 'resumed',
          thread: await runtime.resume(threadId, toValue(recorded)),
        };
      }
      return {
        status: 'awaiting_decision',
        thread,
        ...(request ? { requestId: request._id } : {}),
      };
    }

    return { status: 'resumed', thread: await runtime.continue(threadId) };
  }

  private async mustFind(requestId: EntityId): Promise<ApprovalRequest> {
    const request = isEntityId(requestId) ? await this.requests.findById(requestId) : null;
    if (!request) throw new ApprovalNotFoundError(requestId);
    return request;
  }

  private async recordDecision(
    request: ApprovalRequest,
    value: DecisionValue,
    decidedBy: string,
    now: Date,
  ): Promise<ApprovalDecision> {
    const existing = await this.decisions.findByRequestId(request._id);
    if (existing) {
      // A previous attempt recorded a decision and died before delivering it. Reuse it only if it is
      // the SAME decision (kind, edited payload and reason): the audit record and what the graph is
      // resumed with must never differ.
      if (!sameDecision(toValue(existing), value)) throw new ApprovalConflictError(request._id);
      return existing;
    }
    try {
      return await this.decisions.insert({
        requestId: request._id,
        decision: value.decision,
        ...(value.decision === 'edit' ? { editedPayload: value.editedPayload } : {}),
        ...(value.decision === 'reject' ? { reason: value.reason } : {}),
        decidedBy,
        decidedAt: now.toISOString(),
      });
    } catch (err) {
      // The unique index on requestId: a concurrent decide won. That is a second decision.
      if (err instanceof DuplicateKeyError)
        throw new ApprovalNotPendingError(request._id, 'decided');
      throw err;
    }
  }

  private async markDecided(request: ApprovalRequest, now: Date): Promise<ApprovalRequest> {
    try {
      const updated = await this.requests.updateById(
        request._id,
        { status: 'decided', decidedAt: now.toISOString() },
        request.version,
      );
      return updated ?? request;
    } catch (err) {
      if (err instanceof VersionConflictError)
        throw new ApprovalNotPendingError(request._id, 'decided');
      throw err;
    }
  }
}
