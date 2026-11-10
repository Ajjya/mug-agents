import { afterAll, beforeAll } from 'vitest';
import { INDEXES } from '../../src/mongo/indexes.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoTasksRepository } from '../../src/repositories/tasks.repository.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';
import { plannerServiceSuite } from '../support/planner-service-suite.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

plannerServiceSuite(async () => {
  for (const name of ['events', 'tasks'] as const) {
    await mongo.db
      .collection(name)
      .drop()
      .catch(() => undefined);
    await mongo.db.collection(name).createIndexes(INDEXES[name]);
  }
  return { events: new MongoEventsRepository(mongo.db), tasks: new MongoTasksRepository(mongo.db) };
});
