import { Inject, Injectable } from '@nestjs/common';
import type { ApprovalGate, EnsureRequestInput } from '../agents/planner/planner.graph.js';
import { DuplicateKeyError } from '../repositories/base.repository.js';
import {
  APPROVAL_REQUESTS_REPOSITORY,
  type ApprovalRequestsRepository,
} from './approvals.repository.js';

/**
 * Writes the ApprovalRequest for a node that is about to suspend. Idempotent per
 * (threadId, runId, nodeName): re-running the node after a resume, or after a crash between this
 * write and the suspend, finds the request instead of creating a second one. The unique index makes
 * that true even for two racing writers.
 */
@Injectable()
export class ApprovalRequestGate implements ApprovalGate {
  constructor(
    @Inject(APPROVAL_REQUESTS_REPOSITORY) private readonly requests: ApprovalRequestsRepository,
  ) {}

  async ensureRequest(input: EnsureRequestInput): Promise<{ id: string }> {
    const existing = await this.requests.findByKey(input.threadId, input.runId, input.nodeName);
    if (existing) return { id: existing._id };
    try {
      const created = await this.requests.insert({
        threadId: input.threadId,
        runId: input.runId,
        nodeName: input.nodeName,
        eventId: input.eventId,
        kind: 'plan_review',
        payload: input.payload,
        status: 'pending',
      });
      return { id: created._id };
    } catch (err) {
      if (!(err instanceof DuplicateKeyError)) throw err;
      const raced = await this.requests.findByKey(input.threadId, input.runId, input.nodeName);
      if (!raced) throw err;
      return { id: raced._id };
    }
  }
}
