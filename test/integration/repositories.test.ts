import { ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidIdError } from '../../src/domain/common.js';
import { INDEXES, type CollectionName } from '../../src/mongo/indexes.js';
import { DuplicateKeyError, SchemaDriftError } from '../../src/repositories/base.repository.js';
import {
  MongoApprovalDecisionsRepository,
  MongoApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoOrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import { MongoSpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { MongoTasksRepository } from '../../src/repositories/tasks.repository.js';
import { eventInput, speakerInput, taskInput } from '../support/fixtures.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';
import {
  approvalDecisionsContract,
  approvalRequestsContract,
  eventsContract,
  organisationsContract,
  speakersContract,
  tasksContract,
} from '../support/repository-contract.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

/** Empty collection with its production indexes (the unique email index is part of behaviour). */
async function fresh(db: Db, name: CollectionName): Promise<void> {
  await db
    .collection(name)
    .drop()
    .catch(() => undefined);
  await db.collection(name).createIndexes(INDEXES[name]);
}

// Shared contract: identical suite runs against the in-memory fakes in test/unit.
eventsContract(async () => {
  await fresh(mongo.db, 'events');
  return new MongoEventsRepository(mongo.db);
});
speakersContract(async () => {
  await fresh(mongo.db, 'speakers');
  return new MongoSpeakersRepository(mongo.db);
});
organisationsContract(async () => {
  await fresh(mongo.db, 'organisations');
  return new MongoOrganisationsRepository(mongo.db);
});
tasksContract(async () => {
  await fresh(mongo.db, 'tasks');
  return new MongoTasksRepository(mongo.db);
});
approvalRequestsContract(async () => {
  await fresh(mongo.db, 'approval_requests');
  return new MongoApprovalRequestsRepository(mongo.db);
});
approvalDecisionsContract(async () => {
  await fresh(mongo.db, 'approval_decisions');
  return new MongoApprovalDecisionsRepository(mongo.db);
});

describe('Mongo-specific behaviour', () => {
  it('stores Date / ObjectId and exposes ISO strings / hex ids', async () => {
    await fresh(mongo.db, 'events');
    const repo = new MongoEventsRepository(mongo.db);
    const venue = 'c'.repeat(24);
    const doc = await repo.insert(
      eventInput({ date: '2026-05-01T18:00:00Z', venueOrganisationId: venue }),
    );
    expect(doc.date).toBe('2026-05-01T18:00:00.000Z');
    const raw = await mongo.db.collection('events').findOne({ _id: new ObjectId(doc._id) });
    expect(raw?.['date']).toBeInstanceOf(Date);
    expect(raw?.['createdAt']).toBeInstanceOf(Date);
    expect(raw?.['venueOrganisationId']).toBeInstanceOf(ObjectId);
  });

  it('a malformed cursor throws InvalidIdError (not a driver BSONError)', async () => {
    await fresh(mongo.db, 'tasks');
    const repo = new MongoTasksRepository(mongo.db);
    await expect(repo.findMany({ after: 'garbage' })).rejects.toBeInstanceOf(InvalidIdError);
  });

  describe('read validation (schema drift)', () => {
    it.each([
      [
        'events',
        () => new MongoEventsRepository(mongo.db),
        () => eventInput(),
        { phase: 'planning' },
      ],
      ['speakers', () => new MongoSpeakersRepository(mongo.db), () => speakerInput(), { bio: 'x' }],
      ['tasks', () => new MongoTasksRepository(mongo.db), () => taskInput(), { status: 'done' }],
    ] as const)(
      '%s: a drifted stored document throws SchemaDriftError',
      async (name, make, input, patch) => {
        await fresh(mongo.db, name);
        const repo = make() as never as {
          insert(i: unknown): Promise<{ _id: string; version: number }>;
          findById(id: string): Promise<unknown>;
          findMany(): Promise<unknown>;
          updateById(id: string, p: unknown, v: number): Promise<unknown>;
        };
        const doc = await repo.insert(input());
        await mongo.db
          .collection(name)
          .updateOne({ _id: new ObjectId(doc._id) }, { $set: { surprise: 'not in schema' } });
        await expect(repo.findById(doc._id)).rejects.toBeInstanceOf(SchemaDriftError);
        await expect(repo.findMany()).rejects.toBeInstanceOf(SchemaDriftError);
        await expect(repo.updateById(doc._id, patch, doc.version)).rejects.toBeInstanceOf(
          SchemaDriftError,
        );
      },
    );

    it('after a drifted document the caller can resume past it', async () => {
      await fresh(mongo.db, 'tasks');
      const repo = new MongoTasksRepository(mongo.db);
      await repo.insert(taskInput({ title: 'a' }));
      const bad = await repo.insert(taskInput({ title: 'bad' }));
      const d = await repo.insert(taskInput({ title: 'd' }));
      await mongo.db
        .collection('tasks')
        .updateOne({ _id: new ObjectId(bad._id) }, { $set: { surprise: 1 } });
      const err = await repo.findMany().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SchemaDriftError);
      expect((err as SchemaDriftError).documentId).toBe(bad._id);
      const resumed = await repo.findMany({ after: (err as SchemaDriftError).documentId });
      expect(resumed.items.map((i) => i._id)).toEqual([d._id]);
    });
  });

  describe('speakers.email unique index', () => {
    it('surfaces MongoDB error 11000 as DuplicateKeyError on the email key', async () => {
      await fresh(mongo.db, 'speakers');
      const repo = new MongoSpeakersRepository(mongo.db);
      await repo.insert(speakerInput({ email: 'dup@example.com' }));
      await expect(repo.insert(speakerInput({ email: 'dup@example.com' }))).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DuplicateKeyError && e.collection === 'speakers' && 'email' in e.keyPattern,
      );
    });
  });
});
