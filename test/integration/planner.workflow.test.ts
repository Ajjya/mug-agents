import { afterAll, beforeAll } from 'vitest';
import {
  MongoApprovalDecisionsRepository,
  MongoApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { createCheckpointer } from '../../src/graph/checkpointer.module.js';
import { LOCKS_COLLECTION, MongoThreadLock } from '../../src/graph/thread-lock.js';
import { CheckpointRetention } from '../../src/graph/retention.js';
import { INDEXES, type CollectionName } from '../../src/mongo/indexes.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoTasksRepository } from '../../src/repositories/tasks.repository.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';
import { plannerWorkflowSuite } from '../support/planner-workflow-suite.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

const COLLECTIONS_USED: CollectionName[] = [
  'events',
  'tasks',
  'approval_requests',
  'approval_decisions',
  'graph_checkpoints',
  'graph_checkpoint_writes',
];

// The same scenarios as test/unit/planner.workflow.test.ts, now on MongoDB and the real MongoDB
// checkpointer (on the shared client) with the real retention service.
plannerWorkflowSuite(async () => {
  await mongo.db
    .collection(LOCKS_COLLECTION)
    .drop()
    .catch(() => undefined);
  for (const name of COLLECTIONS_USED) {
    await mongo.db
      .collection(name)
      .drop()
      .catch(() => undefined);
    await mongo.db.collection(name).createIndexes(INDEXES[name]);
  }
  return {
    repos: {
      events: new MongoEventsRepository(mongo.db),
      tasks: new MongoTasksRepository(mongo.db),
      requests: new MongoApprovalRequestsRepository(mongo.db),
      decisions: new MongoApprovalDecisionsRepository(mongo.db),
    },
    saver: createCheckpointer(mongo.client, mongo.db),
    retention: new CheckpointRetention(mongo.db, 30),
    lock: new MongoThreadLock(mongo.db),
  };
});
