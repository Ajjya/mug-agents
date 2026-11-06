import { ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EntityId } from '../../src/domain/common.js';
import type { Event, EventInput, EventPatch } from '../../src/domain/event.schema.js';
import type {
  Organisation,
  OrganisationInput,
  OrganisationPatch,
} from '../../src/domain/organisation.schema.js';
import type { Speaker, SpeakerInput, SpeakerPatch } from '../../src/domain/speaker.schema.js';
import type { Task, TaskInput, TaskPatch } from '../../src/domain/task.schema.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoOrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import { MongoSpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { MongoTasksRepository } from '../../src/repositories/tasks.repository.js';
import {
  InvalidPatchError,
  SchemaDriftError,
  type Repository,
} from '../../src/repositories/base.repository.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';
import { eventInput, organisationInput, speakerInput, taskInput } from '../support/fixtures.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

interface Case<I, D extends { _id: EntityId; createdAt: string; updatedAt: string }, P> {
  name: string;
  collection: string;
  make(db: Db): Repository<I, D, P>;
  input(n: number): I;
  patch: P;
  /** Field that `patch` changes, and its expected new value. */
  patched: [keyof D, unknown];
  unknownFieldInput: unknown;
  invalidPatch: unknown;
}

function suite<I, D extends { _id: EntityId; createdAt: string; updatedAt: string }, P>(
  c: Case<I, D, P>,
): void {
  describe(`${c.name} repository`, () => {
    let repo: Repository<I, D, P>;
    beforeEach(async () => {
      await mongo.db
        .collection(c.collection)
        .drop()
        .catch(() => undefined); // test cleanup only
      repo = c.make(mongo.db);
    });

    it('insert: sets _id and timestamps, persists, returns the domain document', async () => {
      const doc = await repo.insert(c.input(1));
      expect(doc._id).toMatch(/^[0-9a-f]{24}$/);
      expect(doc.createdAt).toBe(doc.updatedAt);
      expect(() => new Date(doc.createdAt).toISOString()).not.toThrow();
      const raw = await mongo.db.collection(c.collection).findOne({ _id: new ObjectId(doc._id) });
      expect(raw?.['createdAt']).toBeInstanceOf(Date);
    });

    it('insert: rejects unknown fields and caller-supplied timestamps', async () => {
      await expect(repo.insert(c.unknownFieldInput as I)).rejects.toBeInstanceOf(z.ZodError);
      await expect(
        repo.insert({ ...c.input(1), createdAt: '2026-01-01T00:00:00.000Z' }),
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(await repo.count()).toBe(0);
    });

    it('findById: returns the document, or null when missing', async () => {
      const doc = await repo.insert(c.input(1));
      expect(await repo.findById(doc._id)).toEqual(doc);
      expect(await repo.findById('f'.repeat(24))).toBeNull();
    });

    it('count: counts all documents and honours a filter', async () => {
      const doc = await repo.insert(c.input(1));
      await repo.insert(c.input(2));
      expect(await repo.count()).toBe(2);
      expect(await repo.count({ _id: new ObjectId(doc._id) })).toBe(1);
    });

    it('findMany: keyset-paginates in both directions without skip', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await repo.insert(c.input(i)))._id);

      const seen: string[] = [];
      let after: EntityId | undefined;
      let pages = 0;
      do {
        const page = await repo.findMany({}, { limit: 2, ...(after ? { after } : {}) });
        seen.push(...page.items.map((d) => d._id));
        after = page.nextCursor;
        pages++;
      } while (after);
      expect(pages).toBe(3);
      expect(seen).toEqual(ids);

      const desc = await repo.findMany({}, { limit: 2, sort: 'desc' });
      expect(desc.items.map((d) => d._id)).toEqual([ids[4], ids[3]]);
      const desc2 = await repo.findMany(
        {},
        { limit: 10, sort: 'desc', after: desc.nextCursor as string },
      );
      expect(desc2.items.map((d) => d._id)).toEqual([ids[2], ids[1], ids[0]]);
      expect(desc2.nextCursor).toBeUndefined();
    });

    it('findMany: applies the filter and clamps limit', async () => {
      const a = await repo.insert(c.input(1));
      await repo.insert(c.input(2));
      const page = await repo.findMany({ _id: new ObjectId(a._id) }, { limit: 0 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeUndefined();
    });

    it('updateById: applies the patch, bumps updatedAt, keeps createdAt', async () => {
      const doc = await repo.insert(c.input(1));
      await new Promise((r) => setTimeout(r, 5));
      const updated = await repo.updateById(doc._id, c.patch);
      expect(updated?.[c.patched[0]]).toEqual(c.patched[1]);
      expect(updated?.createdAt).toBe(doc.createdAt);
      expect(new Date(updated?.updatedAt ?? 0).getTime()).toBeGreaterThan(
        new Date(doc.updatedAt).getTime(),
      );
      expect(await repo.findById(doc._id)).toEqual(updated);
    });

    it('updateById: null for a missing id; rejects invalid and empty patches', async () => {
      expect(await repo.updateById('f'.repeat(24), c.patch)).toBeNull();
      const doc = await repo.insert(c.input(1));
      await expect(repo.updateById(doc._id, c.invalidPatch as P)).rejects.toBeInstanceOf(
        z.ZodError,
      );
      await expect(repo.updateById(doc._id, {} as P)).rejects.toBeInstanceOf(InvalidPatchError);
      expect(await repo.findById(doc._id)).toEqual(doc);
    });

    it('read validation: a drifted stored document throws SchemaDriftError', async () => {
      const doc = await repo.insert(c.input(1));
      await mongo.db
        .collection(c.collection)
        .updateOne({ _id: new ObjectId(doc._id) }, { $set: { surprise: 'not in schema' } });
      await expect(repo.findById(doc._id)).rejects.toBeInstanceOf(SchemaDriftError);
      await expect(repo.findMany()).rejects.toBeInstanceOf(SchemaDriftError);
      await expect(repo.updateById(doc._id, c.patch)).rejects.toBeInstanceOf(SchemaDriftError);
    });
  });
}

suite<EventInput, Event, EventPatch>({
  name: 'Events',
  collection: 'events',
  make: (db) => new MongoEventsRepository(db),
  input: (n) => eventInput({ title: `Event ${String(n)}` }),
  patch: { phase: 'planning' },
  patched: ['phase', 'planning'],
  unknownFieldInput: { ...eventInput(), surprise: 1 },
  invalidPatch: { phase: 'nope' },
});
suite<SpeakerInput, Speaker, SpeakerPatch>({
  name: 'Speakers',
  collection: 'speakers',
  make: (db) => new MongoSpeakersRepository(db),
  input: (n) => speakerInput({ name: `Speaker ${String(n)}`, email: `s${String(n)}@example.com` }),
  patch: { bio: 'Hello' },
  patched: ['bio', 'Hello'],
  unknownFieldInput: { ...speakerInput(), surprise: 1 },
  invalidPatch: { email: 'bad' },
});
suite<OrganisationInput, Organisation, OrganisationPatch>({
  name: 'Organisations',
  collection: 'organisations',
  make: (db) => new MongoOrganisationsRepository(db),
  input: (n) => organisationInput({ name: `Org ${String(n)}` }),
  patch: { kind: 'sponsor' },
  patched: ['kind', 'sponsor'],
  unknownFieldInput: { ...organisationInput(), surprise: 1 },
  invalidPatch: { kind: 'nope' },
});
suite<TaskInput, Task, TaskPatch>({
  name: 'Tasks',
  collection: 'tasks',
  make: (db) => new MongoTasksRepository(db),
  input: (n) => taskInput({ title: `Task ${String(n)}` }),
  patch: { status: 'done' },
  patched: ['status', 'done'],
  unknownFieldInput: { ...taskInput(), surprise: 1 },
  invalidPatch: { source: 'agent' },
});

describe('dates and references round-trip', () => {
  it('stores Date / ObjectId and exposes ISO strings / hex ids', async () => {
    const repo = new MongoEventsRepository(mongo.db);
    const venue = 'c'.repeat(24);
    const doc = await repo.insert(
      eventInput({ date: '2026-05-01T18:00:00Z', venueOrganisationId: venue }),
    );
    expect(doc.date).toBe('2026-05-01T18:00:00.000Z');
    const raw = await mongo.db.collection('events').findOne({ _id: new ObjectId(doc._id) });
    expect(raw?.['date']).toBeInstanceOf(Date);
    expect(raw?.['venueOrganisationId']).toBeInstanceOf(ObjectId);
  });
});

describe('speakers.email unique index', () => {
  it('rejects a duplicate email but allows several speakers without one', async () => {
    const { ensureIndexes } = await import('../../src/mongo/indexes.js');
    const { Logger } = await import('@nestjs/common');
    await ensureIndexes(mongo.db, new Logger('test'));
    const repo = new MongoSpeakersRepository(mongo.db);
    await repo.insert(speakerInput({ email: 'dup@example.com' }));
    await expect(repo.insert(speakerInput({ email: 'dup@example.com' }))).rejects.toMatchObject({
      code: 11000,
    });
    await repo.insert(speakerInput({ name: 'No email 1' }));
    await repo.insert(speakerInput({ name: 'No email 2' }));
  });
});
