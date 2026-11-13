import {
  InMemoryApprovalDecisionsRepository,
  InMemoryApprovalRequestsRepository,
  InMemoryEventsRepository,
  InMemoryTasksRepository,
} from '../support/in-memory.repositories.js';
import { plannerWorkflowSuite } from '../support/planner-workflow-suite.js';

plannerWorkflowSuite(() =>
  Promise.resolve({
    repos: {
      events: new InMemoryEventsRepository(),
      tasks: new InMemoryTasksRepository(),
      requests: new InMemoryApprovalRequestsRepository(),
      decisions: new InMemoryApprovalDecisionsRepository(),
    },
  }),
);
