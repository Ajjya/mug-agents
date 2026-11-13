import { Module } from '@nestjs/common';
import { MongoModule } from '../mongo/mongo.module.js';
import { PlannerModule } from '../agents/planner/planner.module.js';
import { ApprovalRequestGate } from './approval-gate.js';
import {
  APPROVAL_DECISIONS_REPOSITORY,
  APPROVAL_REQUESTS_REPOSITORY,
  MongoApprovalDecisionsRepository,
  MongoApprovalRequestsRepository,
} from './approvals.repository.js';
import { ApprovalsService } from './approvals.service.js';

export const APPROVALS_GATE = Symbol('APPROVALS_GATE');

/** Repositories and the idempotent request gate. Used by the planner graph and by ApprovalsService. */
@Module({
  imports: [MongoModule],
  providers: [
    { provide: APPROVAL_REQUESTS_REPOSITORY, useClass: MongoApprovalRequestsRepository },
    { provide: APPROVAL_DECISIONS_REPOSITORY, useClass: MongoApprovalDecisionsRepository },
    { provide: APPROVALS_GATE, useClass: ApprovalRequestGate },
  ],
  exports: [APPROVAL_REQUESTS_REPOSITORY, APPROVAL_DECISIONS_REPOSITORY, APPROVALS_GATE],
})
export class ApprovalsStoreModule {}

/** The approval workflow: list, show, decide, resume. Depends on the planner's runtime. */
@Module({
  imports: [ApprovalsStoreModule, PlannerModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
