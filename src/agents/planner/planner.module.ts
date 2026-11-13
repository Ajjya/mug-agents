import { Module } from '@nestjs/common';
import { ApprovalsStoreModule } from '../../approvals/approvals.module.js';
import { APPROVALS_GATE } from '../../approvals/approvals.module.js';
import { PLANNER_RUNTIME } from '../../approvals/approvals.service.js';
import type { ApprovalGate } from './planner.graph.js';
import {
  CHECKPOINTER,
  CHECKPOINT_RETENTION,
  CheckpointerModule,
} from '../../graph/checkpointer.module.js';
import type { CheckpointRetention } from '../../graph/retention.js';
import { STRUCTURED_CALL } from '../../llm/llm.module.js';
import type { StructuredCall } from '../../llm/structured.js';
import { EVENTS_REPOSITORY, type EventsRepository } from '../../repositories/events.repository.js';
import { RepositoriesModule } from '../../repositories/repositories.module.js';
import { TASKS_REPOSITORY, type TasksRepository } from '../../repositories/tasks.repository.js';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { PlanPersistence } from './plan-persistence.js';
import { buildApprovalGraph } from './planner.graph.js';
import { PlannerRuntime } from './planner.runtime.js';
import { PLAN_PERSISTENCE, PlannerService } from './planner.service.js';

@Module({
  imports: [RepositoriesModule, ApprovalsStoreModule, CheckpointerModule],
  providers: [
    {
      provide: PLAN_PERSISTENCE,
      inject: [EVENTS_REPOSITORY, TASKS_REPOSITORY],
      useFactory: (events: EventsRepository, tasks: TasksRepository) =>
        new PlanPersistence(events, tasks),
    },
    {
      provide: PLANNER_RUNTIME,
      inject: [
        STRUCTURED_CALL,
        APPROVALS_GATE,
        PLAN_PERSISTENCE,
        CHECKPOINTER,
        CHECKPOINT_RETENTION,
      ],
      useFactory: (
        call: StructuredCall,
        gate: ApprovalGate,
        persistence: PlanPersistence,
        checkpointer: BaseCheckpointSaver,
        retention: CheckpointRetention,
      ) =>
        new PlannerRuntime(
          buildApprovalGraph({ call, gate, persistence }, checkpointer),
          retention,
        ),
    },
    PlannerService,
  ],
  exports: [PlannerService, PLANNER_RUNTIME, PLAN_PERSISTENCE],
})
export class PlannerModule {}
