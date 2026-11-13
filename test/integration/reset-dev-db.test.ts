import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ResetRefusedError, resetDevDb } from '../../scripts/reset-dev-db.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

describe('resetDevDb (real MongoDB)', () => {
  it('drops the configured _dev database, reports what it held, and leaves other databases alone', async () => {
    const name = `t${randomUUID().replaceAll('-', '')}_dev`;
    const target = mongo.client.db(name);
    await target.collection('events').insertMany([{ a: 1 }, { a: 2 }]);
    await target.collection('tasks').insertOne({ b: 1 });
    await mongo.db.collection('keep').insertOne({ safe: true });

    const report = await resetDevDb(mongo.client, { NODE_ENV: 'development', MONGODB_DB: name });

    expect(report.database).toBe(name);
    expect([...report.collections].sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: 'events', documents: 2 },
      { name: 'tasks', documents: 1 },
    ]);
    const dbs = (await mongo.client.db().admin().listDatabases()).databases.map((d) => d.name);
    expect(dbs).not.toContain(name);
    expect(await mongo.db.collection('keep').countDocuments()).toBe(1);
  });

  it('names the unfinished graph threads it discards, and not the finished ones', async () => {
    const name = `t${randomUUID().replaceAll('-', '')}_dev`;
    const checkpoints = mongo.client.db(name).collection('graph_checkpoints');
    await checkpoints.insertMany([
      { thread_id: 'event:a:plan', checkpoint_id: '1' }, // paused or failed: no expire_at
      { thread_id: 'event:a:plan', checkpoint_id: '2' },
      { thread_id: 'event:b:plan', checkpoint_id: '1', expire_at: new Date('2030-01-01') }, // finished
    ]);
    const report = await resetDevDb(mongo.client, { NODE_ENV: 'development', MONGODB_DB: name });
    expect(report.discardedThreads).toEqual(['event:a:plan']);
    expect(report.collections).toEqual([{ name: 'graph_checkpoints', documents: 3 }]);
  });

  it('an empty or missing database is not an error', async () => {
    const report = await resetDevDb(mongo.client, {
      NODE_ENV: 'development',
      MONGODB_DB: `t${randomUUID().replaceAll('-', '')}_dev`,
    });
    expect(report.collections).toEqual([]);
    expect(report.discardedThreads).toEqual([]);
  });

  it('refuses a database without the _dev suffix and drops nothing', async () => {
    await mongo.db.collection('data').insertOne({ x: 1 });
    await expect(
      resetDevDb(mongo.client, { NODE_ENV: 'development', MONGODB_DB: mongo.dbName }),
    ).rejects.toBeInstanceOf(ResetRefusedError);
    expect(await mongo.db.collection('data').countDocuments()).toBe(1);
  });

  it('refuses in production even for a _dev name, and drops nothing', async () => {
    const name = `t${randomUUID().replaceAll('-', '')}_dev`;
    await mongo.client.db(name).collection('c').insertOne({ x: 1 });
    await expect(
      resetDevDb(mongo.client, { NODE_ENV: 'production', MONGODB_DB: name }),
    ).rejects.toBeInstanceOf(ResetRefusedError);
    expect(await mongo.client.db(name).collection('c').countDocuments()).toBe(1);
    await mongo.client.db(name).dropDatabase(); // test cleanup
  });
});
