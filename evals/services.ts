import { MemorySaver } from '@langchain/langgraph';
import { PlanPersistence } from '../src/agents/planner/plan-persistence.js';
import { buildApprovalGraph } from '../src/agents/planner/planner.graph.js';
import { PlannerRuntime } from '../src/agents/planner/planner.runtime.js';
import { PlannerService } from '../src/agents/planner/planner.service.js';
import { ApprovalRequestGate } from '../src/approvals/approval-gate.js';
import { ApprovalsService } from '../src/approvals/approvals.service.js';
import type { StructuredCall } from '../src/llm/structured.js';
import {
  InMemoryApprovalDecisionsRepository,
  InMemoryApprovalRequestsRepository,
  InMemoryEventsRepository,
  InMemoryTasksRepository,
} from '../test/support/in-memory.repositories.js';

/**
 * The real planner graph, approval workflow and services over in-memory storage (same contract as
 * MongoDB) and an in-memory checkpointer. Evals use it so they never touch a database.
 */
export function buildEvalServices(call: StructuredCall) {
  const events = new InMemoryEventsRepository();
  const tasks = new InMemoryTasksRepository();
  const requests = new InMemoryApprovalRequestsRepository();
  const decisions = new InMemoryApprovalDecisionsRepository();
  const persistence = new PlanPersistence(events, tasks);
  const runtime = new PlannerRuntime(
    buildApprovalGraph(
      { call, gate: new ApprovalRequestGate(requests), persistence },
      new MemorySaver(),
    ),
    {
      scheduleExpiry: () => Promise.resolve(),
      cancelExpiry: () => Promise.resolve(),
      inFlightThreadIds: () => Promise.resolve([]),
    },
  );
  return {
    events,
    tasks,
    persistence,
    planner: new PlannerService(persistence, runtime, requests),
    approvals: new ApprovalsService(requests, decisions, runtime),
  };
}
