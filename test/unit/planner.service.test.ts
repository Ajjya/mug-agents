import {
  InMemoryEventsRepository,
  InMemoryTasksRepository,
} from '../support/in-memory.repositories.js';
import { plannerServiceSuite } from '../support/planner-service-suite.js';

plannerServiceSuite(() =>
  Promise.resolve({ events: new InMemoryEventsRepository(), tasks: new InMemoryTasksRepository() }),
);
