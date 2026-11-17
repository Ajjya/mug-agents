import { Module } from '@nestjs/common';
import { PlannerModule } from '../agents/planner/planner.module.js';
import { ApprovalsStoreModule } from './approvals-store.module.js';
import type { PlannerRuntime } from '../agents/planner/planner.runtime.js';
import { SPEAKERS_RUNTIME, SpeakersModule } from '../agents/speakers/speakers.module.js';
import type { SpeakersRuntime } from '../agents/speakers/speakers.runtime.js';
import { ApprovalsService, GRAPH_RUNTIMES, PLANNER_RUNTIME } from './approvals.service.js';

/** The approval workflow: list, show, decide, resume, for every approval graph (plan, speakers). */
@Module({
  imports: [ApprovalsStoreModule, PlannerModule, SpeakersModule],
  providers: [
    {
      provide: GRAPH_RUNTIMES,
      inject: [PLANNER_RUNTIME, SPEAKERS_RUNTIME],
      useFactory: (plan: PlannerRuntime, speakers: SpeakersRuntime) => [plan, speakers],
    },
    ApprovalsService,
  ],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
