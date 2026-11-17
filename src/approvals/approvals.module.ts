import { Module } from '@nestjs/common';
import { PlannerModule } from '../agents/planner/planner.module.js';
import { ApprovalsStoreModule } from './approvals-store.module.js';
import type { PlannerRuntime } from '../agents/planner/planner.runtime.js';
import { ApprovalsService, GRAPH_RUNTIMES, PLANNER_RUNTIME } from './approvals.service.js';

/** The approval workflow: list, show, decide, resume. Depends on the planner's runtime. */
@Module({
  imports: [ApprovalsStoreModule, PlannerModule],
  providers: [
    {
      provide: GRAPH_RUNTIMES,
      inject: [PLANNER_RUNTIME],
      useFactory: (plan: PlannerRuntime) => [plan],
    },
    ApprovalsService,
  ],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
