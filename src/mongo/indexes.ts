import { Logger } from '@nestjs/common';
import { type Collection, type Db, type IndexDescription, MongoServerError } from 'mongodb';

export const COLLECTIONS = {
  events: 'events',
  speakers: 'speakers',
  organisations: 'organisations',
  tasks: 'tasks',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** Index definitions per collection. Names are explicit so ensureIndexes is idempotent. */
export const INDEXES: Record<CollectionName, IndexDescription[]> = {
  events: [
    { key: { date: 1 }, name: 'events_date' },
    { key: { phase: 1 }, name: 'events_phase' },
  ],
  speakers: [{ key: { email: 1 }, name: 'speakers_email_unique', unique: true, sparse: true }],
  organisations: [{ key: { kind: 1 }, name: 'organisations_kind' }],
  tasks: [{ key: { status: 1, dueAt: 1 }, name: 'tasks_status_dueAt' }],
};

const NAMESPACE_NOT_FOUND = 26;

/**
 * listIndexes fails with NamespaceNotFound when the collection does not exist yet (first start):
 * that, and only that, means "no indexes". Anything else (auth, network, ...) fails startup.
 */
async function existingIndexes(col: Collection): Promise<{ name?: string }[]> {
  try {
    return await col.indexes();
  } catch (err) {
    if (err instanceof MongoServerError && err.code === NAMESPACE_NOT_FOUND) return [];
    throw err;
  }
}

/**
 * Creates any missing indexes. Safe to run on every start: createIndexes is a no-op for an
 * index that already exists with the same definition. Returns the names it ensured.
 */
export async function ensureIndexes(db: Db, logger: Logger): Promise<string[]> {
  const perCollection = await Promise.all(
    Object.entries(INDEXES).map(async ([collection, indexes]) => {
      const col = db.collection(collection);
      const existing = new Set((await existingIndexes(col)).map((i) => i.name));
      const names = await col.createIndexes(indexes);
      for (const name of names) {
        if (!existing.has(name)) logger.log(`created index ${collection}.${name}`);
      }
      return names.map((name) => `${collection}.${name}`);
    }),
  );
  const ensured = perCollection.flat();
  logger.log(`indexes ensured (${String(ensured.length)})`);
  return ensured;
}
