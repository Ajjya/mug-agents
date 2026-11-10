import { Module } from '@nestjs/common';
import { STRUCTURED_CALL } from '../../llm/llm.module.js';
import type { StructuredCall } from '../../llm/structured.js';
import { RepositoriesModule } from '../../repositories/repositories.module.js';
import { LangGraphPlanner } from './planner.graph.js';
import { PLANNER_GRAPH, PlannerService } from './planner.service.js';

@Module({
  imports: [RepositoriesModule],
  providers: [
    {
      provide: PLANNER_GRAPH,
      useFactory: (call: StructuredCall) => new LangGraphPlanner(call),
      inject: [STRUCTURED_CALL],
    },
    PlannerService,
  ],
  exports: [PlannerService],
})
export class PlannerModule {}
