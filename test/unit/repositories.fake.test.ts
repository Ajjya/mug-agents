import {
  InMemoryApprovalDecisionsRepository,
  InMemoryApprovalRequestsRepository,
  InMemoryEventsRepository,
  InMemoryOrganisationsRepository,
  InMemorySpeakersRepository,
  InMemoryTasksRepository,
} from '../support/in-memory.repositories.js';
import {
  approvalDecisionsContract,
  approvalRequestsContract,
  eventsContract,
  organisationsContract,
  speakersContract,
  tasksContract,
} from '../support/repository-contract.js';

// The same contract suite runs against the Mongo repositories in test/integration.
eventsContract(() => new InMemoryEventsRepository());
speakersContract(() => new InMemorySpeakersRepository());
organisationsContract(() => new InMemoryOrganisationsRepository());
tasksContract(() => new InMemoryTasksRepository());
approvalRequestsContract(() => new InMemoryApprovalRequestsRepository());
approvalDecisionsContract(() => new InMemoryApprovalDecisionsRepository());
