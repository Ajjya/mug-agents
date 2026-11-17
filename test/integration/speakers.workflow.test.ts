import { afterAll, beforeAll } from 'vitest';
import {
  MongoApprovalDecisionsRepository,
  MongoApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { createCheckpointer } from '../../src/graph/checkpointer.module.js';
import { CheckpointRetention } from '../../src/graph/retention.js';
import { LOCKS_COLLECTION, MongoThreadLock } from '../../src/graph/thread-lock.js';
import { INDEXES, type CollectionName } from '../../src/mongo/indexes.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoMessagesRepository } from '../../src/repositories/messages.repository.js';
import { MongoOrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import { MongoSpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { MongoTasksRepository } from '../../src/repositories/tasks.repository.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';
import { speakersWorkflowSuite } from '../support/speakers-workflow-suite.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

const USED: CollectionName[] = [
  'events',
  'speakers',
  'organisations',
  'messages',
  'tasks',
  'approval_requests',
  'approval_decisions',
  'graph_checkpoints',
  'graph_checkpoint_writes',
];

// The same scenarios as test/unit/speakers.workflow.test.ts, on MongoDB (unique indexes included)
// and the real MongoDB checkpointer, retention and cross-process lock.
speakersWorkflowSuite(
  'MongoDB',
  async () => {
    await mongo.db
      .collection(LOCKS_COLLECTION)
      .drop()
      .catch(() => undefined);
    for (const name of USED) {
      await mongo.db
        .collection(name)
        .drop()
        .catch(() => undefined);
      await mongo.db.collection(name).createIndexes(INDEXES[name]);
    }
    return {
      events: new MongoEventsRepository(mongo.db),
      speakers: new MongoSpeakersRepository(mongo.db),
      organisations: new MongoOrganisationsRepository(mongo.db),
      messages: new MongoMessagesRepository(mongo.db),
      tasks: new MongoTasksRepository(mongo.db),
      requests: new MongoApprovalRequestsRepository(mongo.db),
      decisions: new MongoApprovalDecisionsRepository(mongo.db),
    };
  },
  () => ({
    saver: createCheckpointer(mongo.client, mongo.db),
    retention: new CheckpointRetention(mongo.db, 30),
    lock: new MongoThreadLock(mongo.db),
  }),
);
