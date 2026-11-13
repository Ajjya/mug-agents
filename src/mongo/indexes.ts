import { Logger } from '@nestjs/common';
import { type Collection, type Db, type IndexDescription, MongoServerError } from 'mongodb';

export const COLLECTIONS = {
  events: 'events',
  speakers: 'speakers',
  organisations: 'organisations',
  tasks: 'tasks',
  approvalRequests: 'approval_requests',
  approvalDecisions: 'approval_decisions',
  // Operational data owned by the LangGraph MongoDB checkpointer (see src/graph).
  graphCheckpoints: 'graph_checkpoints',
  graphCheckpointWrites: 'graph_checkpoint_writes',
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
  tasks: [
    { key: { status: 1, dueAt: 1 }, name: 'tasks_status_dueAt' },
    { key: { relatedEventId: 1 }, name: 'tasks_relatedEventId' },
  ],
  // At most one request per (thread, run, node): a re-run node can never create a second one.
  approval_requests: [
    {
      key: { threadId: 1, runId: 1, nodeName: 1 },
      name: 'approval_requests_thread_run_node_unique',
      unique: true,
    },
    { key: { status: 1, createdAt: 1 }, name: 'approval_requests_status_createdAt' },
  ],
  // Deciding a request twice is a bug: one decision per request, enforced by the database.
  approval_decisions: [
    { key: { requestId: 1 }, name: 'approval_decisions_requestId_unique', unique: true },
  ],
  // Same keys and names the saver's own setup() would create, declared here so startup stays the one
  // place indexes live. The TTL index acts only on documents that have `expire_at`: the retention
  // service stamps it when a thread COMPLETES, so a paused or failed thread is never expired.
  graph_checkpoints: [
    {
      key: { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 },
      name: 'thread_ns_checkpoint_idx',
    },
    { key: { expire_at: 1 }, name: 'graph_checkpoints_expire_at', expireAfterSeconds: 0 },
  ],
  graph_checkpoint_writes: [
    {
      key: { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, task_id: 1, idx: 1 },
      name: 'thread_ns_checkpoint_task_idx',
    },
    { key: { expire_at: 1 }, name: 'graph_checkpoint_writes_expire_at', expireAfterSeconds: 0 },
  ],
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
