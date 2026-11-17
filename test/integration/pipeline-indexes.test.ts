import { Logger } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../../src/mongo/indexes.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

let mongo: TestMongo;
const EVENT = new ObjectId();
const SPEAKER = new ObjectId();

beforeAll(async () => {
  mongo = await openTestMongo();
  await ensureIndexes(mongo.db, new Logger('test'));
  // Enough documents, from many events, that a scan is clearly the worse plan.
  await mongo.db.collection(COLLECTIONS.speakers).insertMany(
    Array.from({ length: 300 }, (_, i) => ({
      name: `Speaker ${String(i)}`,
      topics: [],
      links: {},
      perEvent: [
        { eventId: i === 7 ? EVENT : new ObjectId(), status: 'idea', updatedAt: new Date() },
      ],
    })),
  );
  await mongo.db.collection(COLLECTIONS.messages).insertMany(
    Array.from({ length: 300 }, (_, i) => ({
      eventId: i === 7 ? EVENT : new ObjectId(),
      speakerId: i === 7 ? SPEAKER : new ObjectId(),
      status: i === 7 ? 'sent' : 'draft',
      idempotencyKey: `k${String(i)}`,
    })),
  );
});
afterAll(async () => {
  await mongo.close();
});

const plan = async (collection: string, filter: object): Promise<string> => {
  const explained = await mongo.db
    .collection(collection)
    .find(filter)
    .sort({ _id: 1 })
    .explain('queryPlanner');
  return JSON.stringify(
    (explained as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan,
  );
};

/**
 * The queries SpeakerPipelineStore.load runs on every `speakers run` and `list`, with the filters the
 * repositories build (MongoSpeakersRepository.findByEventId, MongoMessagesRepository.findByEventId and
 * findBySpeakerAndStatus). None may scan the collection.
 */
describe('the pipeline queries use an index', () => {
  it.each([
    [
      'speakers by perEvent.eventId',
      COLLECTIONS.speakers,
      { 'perEvent.eventId': EVENT },
      'speakers_perEvent_eventId',
    ],
    ['messages by eventId', COLLECTIONS.messages, { eventId: EVENT }, 'messages_eventId_speakerId'],
    [
      'messages by speakerId and status',
      COLLECTIONS.messages,
      { speakerId: SPEAKER, status: 'sent' },
      'messages_speakerId_status',
    ],
  ])('%s', async (_name, collection, filter, index) => {
    const winning = await plan(collection, filter);
    expect(winning).toContain('IXSCAN');
    expect(winning).not.toContain('COLLSCAN');
    expect(winning).toContain(index);
  });
});
