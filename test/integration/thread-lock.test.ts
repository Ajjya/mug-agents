import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOCKS_COLLECTION,
  MongoThreadLock,
  ThreadBusyError,
  withLock,
} from '../../src/graph/thread-lock.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
});
afterAll(async () => {
  await mongo.close();
});

describe('MongoThreadLock (cross-process lease)', () => {
  it('a second holder is refused while the lease is live, and gets it once released', async () => {
    const a = new MongoThreadLock(mongo.db);
    const b = new MongoThreadLock(mongo.db); // a different process, same database
    const release = await a.acquire('k1');
    expect(await b.isHeld('k1')).toBe(true);
    const err = await b.acquire('k1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThreadBusyError);
    expect((err as ThreadBusyError).until).toBeInstanceOf(Date);
    await release();
    expect(await b.isHeld('k1')).toBe(false);
    const again = await b.acquire('k1');
    await again();
  });

  it('only one of many simultaneous acquirers wins', async () => {
    const locks = Array.from({ length: 8 }, () => new MongoThreadLock(mongo.db));
    const results = await Promise.allSettled(locks.map((l) => l.acquire('k2')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => r.reason instanceof ThreadBusyError),
    ).toBe(true);
  });

  it('an expired lease (crashed holder) can be taken over, and the old holder cannot release the new one', async () => {
    const crashed = new MongoThreadLock(mongo.db, 1); // 1 ms lease
    const staleRelease = await crashed.acquire('k3');
    await new Promise((r) => setTimeout(r, 10));
    const fresh = new MongoThreadLock(mongo.db);
    const release = await fresh.acquire('k3');
    await staleRelease(); // must not free the new holder's lease
    expect(await fresh.isHeld('k3')).toBe(true);
    await release();
  });

  it('withLock releases on error, and never deletes lease documents', async () => {
    const lock = new MongoThreadLock(mongo.db);
    await expect(withLock(lock, 'k4', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(await lock.isHeld('k4')).toBe(false);
    expect(await mongo.db.collection(LOCKS_COLLECTION).countDocuments({ _id: 'k4' as never })).toBe(
      1,
    );
  });
});
