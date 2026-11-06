import { Logger } from '@nestjs/common';
import type { Db, IndexDescription } from 'mongodb';

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

/**
 * Creates any missing indexes. Safe to run on every start: createIndexes is a no-op for an
 * index that already exists with the same definition. Returns the names it ensured.
 */
export async function ensureIndexes(db: Db, logger: Logger): Promise<string[]> {
  const ensured: string[] = [];
  for (const [collection, indexes] of Object.entries(INDEXES)) {
    const existing = new Set(
      (await db.listCollections({ name: collection }).toArray()).length > 0
        ? (await db.collection(collection).indexes()).map((i) => i.name)
        : [],
    );
    const created = await db.collection(collection).createIndexes(indexes);
    for (const name of created) {
      ensured.push(`${collection}.${name}`);
      if (!existing.has(name)) logger.log(`created index ${collection}.${name}`);
    }
  }
  logger.log(`indexes ensured (${String(ensured.length)})`);
  return ensured;
}
