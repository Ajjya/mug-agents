import type { Db } from 'mongodb';
import { COLLECTIONS } from '../mongo/indexes.js';

const DAY_MS = 86_400_000;

const CHECKPOINT_COLLECTIONS = [COLLECTIONS.graphCheckpoints, COLLECTIONS.graphCheckpointWrites];

/**
 * Bounded retention for checkpoint data without any delete code in src/.
 *
 * Why not the package's own `ttl` option: it puts a TTL index on `upserted_at`, which ages every
 * document individually from its creation. A thread paused for two months would lose its latest
 * checkpoint and could no longer resume.
 *
 * Instead, a thread gets an `expire_at` date only when it COMPLETES (finished, or rejected). A TTL
 * index on `expire_at` (declared in indexes.ts, expireAfterSeconds 0) lets MongoDB itself remove
 * those documents when the date passes. Documents without `expire_at`, i.e. every paused or failed
 * thread, are invisible to the TTL monitor and are never removed.
 */
export class CheckpointRetention {
  constructor(
    private readonly db: Db,
    private readonly ttlDays: number,
  ) {}

  /** Marks every checkpoint document of a completed thread to expire `ttlDays` from `now`. */
  async scheduleExpiry(threadId: string, now: Date = new Date()): Promise<Date> {
    const expireAt = new Date(now.getTime() + this.ttlDays * DAY_MS);
    for (const name of CHECKPOINT_COLLECTIONS) {
      await this.db
        .collection(name)
        .updateMany({ thread_id: threadId }, { $set: { expire_at: expireAt } });
    }
    return expireAt;
  }

  /** A completed thread is being reused (re-plan): its documents must not expire mid-run. */
  async cancelExpiry(threadId: string): Promise<void> {
    for (const name of CHECKPOINT_COLLECTIONS) {
      await this.db
        .collection(name)
        .updateMany({ thread_id: threadId }, { $unset: { expire_at: '' } });
    }
  }

  /** Threads with at least one checkpoint document that is not scheduled to expire (not completed). */
  async inFlightThreadIds(): Promise<string[]> {
    const ids = await this.db
      .collection(COLLECTIONS.graphCheckpoints)
      .distinct('thread_id', { expire_at: { $exists: false } });
    return (ids as string[]).sort();
  }
}
