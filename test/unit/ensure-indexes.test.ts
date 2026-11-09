import { Logger } from '@nestjs/common';
import { type Db, MongoServerError } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { INDEXES, ensureIndexes } from '../../src/mongo/indexes.js';

const quiet = new Logger('test');
vi.spyOn(quiet, 'log').mockImplementation(() => undefined);

/** A Db whose collections' `indexes()` rejects with `listError` (or resolves empty if undefined). */
function fakeDb(listError?: Error) {
  const createIndexes = vi.fn((defs: { name?: string }[]) =>
    Promise.resolve(defs.map((d) => d.name ?? '')),
  );
  const db = {
    collection: () => ({
      indexes: () => (listError ? Promise.reject(listError) : Promise.resolve([])),
      createIndexes,
    }),
  } as unknown as Db;
  return { db, createIndexes };
}

describe('ensureIndexes: listing existing indexes', () => {
  it('treats NamespaceNotFound (26) as "no indexes yet" and creates them', async () => {
    const err = new MongoServerError({
      message: 'ns does not exist',
      code: 26,
      codeName: 'NamespaceNotFound',
    });
    const { db, createIndexes } = fakeDb(err);
    const ensured = await ensureIndexes(db, quiet);
    expect(createIndexes).toHaveBeenCalledTimes(Object.keys(INDEXES).length);
    expect(ensured.length).toBe(Object.values(INDEXES).flat().length);
  });

  it.each([
    [
      'an authorization error',
      new MongoServerError({ message: 'not authorized', code: 13, codeName: 'Unauthorized' }),
    ],
    [
      'a different server error',
      new MongoServerError({ message: 'boom', code: 11600, codeName: 'InterruptedAtShutdown' }),
    ],
    ['a non-Mongo error', new Error('socket closed')],
  ])('fails startup on %s', async (_label, err) => {
    const { db, createIndexes } = fakeDb(err);
    await expect(ensureIndexes(db, quiet)).rejects.toBe(err);
    expect(createIndexes).not.toHaveBeenCalled();
  });
});
