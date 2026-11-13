import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { z } from 'zod';
import { type EntityId, entityId, toStorage } from '../domain/common.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import {
  BaseRepository,
  type FindManyOptions,
  type Page,
  type Repository,
} from '../repositories/base.repository.js';
import {
  ApprovalDecisionInputSchema,
  ApprovalDecisionPatchSchema,
  ApprovalDecisionSchema,
  type ApprovalDecision,
  type ApprovalDecisionInput,
  type ApprovalDecisionPatch,
  ApprovalRequestInputSchema,
  ApprovalRequestPatchSchema,
  ApprovalRequestSchema,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalRequestPatch,
  type ApprovalRequestStatus,
} from './approval.schema.js';

export const APPROVAL_REQUESTS_REPOSITORY = Symbol('APPROVAL_REQUESTS_REPOSITORY');
export const APPROVAL_DECISIONS_REPOSITORY = Symbol('APPROVAL_DECISIONS_REPOSITORY');

const text = z.string().min(1);

/** No delete: a request is never removed. `expired` is a status, not a removal. */
export interface ApprovalRequestsRepository extends Repository<
  ApprovalRequestInput,
  ApprovalRequest,
  ApprovalRequestPatch
> {
  findByStatus(
    status: ApprovalRequestStatus,
    options?: FindManyOptions,
  ): Promise<Page<ApprovalRequest>>;
  /** The request for one node of one run of a thread, whatever its status. */
  findByKey(threadId: string, runId: string, nodeName: string): Promise<ApprovalRequest | null>;
  findByThread(threadId: string, options?: FindManyOptions): Promise<Page<ApprovalRequest>>;
}

export interface ApprovalDecisionsRepository extends Repository<
  ApprovalDecisionInput,
  ApprovalDecision,
  ApprovalDecisionPatch
> {
  findByRequestId(requestId: EntityId): Promise<ApprovalDecision | null>;
}

@Injectable()
export class MongoApprovalRequestsRepository
  extends BaseRepository<
    typeof ApprovalRequestInputSchema,
    typeof ApprovalRequestSchema,
    typeof ApprovalRequestPatchSchema
  >
  implements ApprovalRequestsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.approvalRequests), {
      input: ApprovalRequestInputSchema,
      doc: ApprovalRequestSchema,
      patch: ApprovalRequestPatchSchema,
    });
  }

  async findByStatus(status: ApprovalRequestStatus, options?: FindManyOptions) {
    return await this.findWhere(
      { status: ApprovalRequestInputSchema.shape.status.parse(status) },
      options,
    );
  }

  async findByKey(threadId: string, runId: string, nodeName: string) {
    const page = await this.findWhere(
      { threadId: text.parse(threadId), runId: text.parse(runId), nodeName: text.parse(nodeName) },
      { limit: 1 },
    );
    return page.items[0] ?? null;
  }

  async findByThread(threadId: string, options?: FindManyOptions) {
    return await this.findWhere({ threadId: text.parse(threadId) }, options);
  }
}

@Injectable()
export class MongoApprovalDecisionsRepository
  extends BaseRepository<
    typeof ApprovalDecisionInputSchema,
    typeof ApprovalDecisionSchema,
    typeof ApprovalDecisionPatchSchema
  >
  implements ApprovalDecisionsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.approvalDecisions), {
      input: ApprovalDecisionInputSchema,
      doc: ApprovalDecisionSchema,
      patch: ApprovalDecisionPatchSchema,
    });
  }

  async findByRequestId(requestId: EntityId) {
    const page = await this.findWhere({ requestId: toStorage(entityId, requestId) }, { limit: 1 });
    return page.items[0] ?? null;
  }
}
