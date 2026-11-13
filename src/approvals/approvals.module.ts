import { Module } from '@nestjs/common';
import { PlannerModule } from '../agents/planner/planner.module.js';
import { ApprovalsStoreModule } from './approvals-store.module.js';
import { ApprovalsService } from './approvals.service.js';

/** The approval workflow: list, show, decide, resume. Depends on the planner's runtime. */
@Module({
  imports: [ApprovalsStoreModule, PlannerModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
