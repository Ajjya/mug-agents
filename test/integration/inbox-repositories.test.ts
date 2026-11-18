import { afterAll, beforeAll } from 'vitest';
import { INDEXES, type CollectionName } from '../../src/mongo/indexes.js';
import {
  MongoCandidateThreadsRepository,
  MongoInboundMessagesRepository,
} from '../../src/inbox/repositories.js';
import {
  candidateThreadsContract,
  inboundMessagesContract,
} from '../support/inbox-repository-contract.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

async function fresh(name: CollectionName): Promise<void> {
  await mongo.db
    .collection(name)
    .drop()
    .catch(() => undefined);
  await mongo.db.collection(name).createIndexes(INDEXES[name]);
}

inboundMessagesContract(async () => {
  await fresh('inbound_messages');
  return new MongoInboundMessagesRepository(mongo.db);
});
candidateThreadsContract(async () => {
  await fresh('candidate_threads');
  return new MongoCandidateThreadsRepository(mongo.db);
});
