import { randomUUID } from 'node:crypto';
import { type Collection, type Db, MongoServerError } from 'mongodb';

/** Operational collection holding one lease document per locked key. Never deleted from: a lease
 *  is released by expiring it, so no delete call exists. */
export const LOCKS_COLLECTION = 'graph_locks';

/** Long enough for a whole run (two model nodes, full ladder, timeouts); a crashed holder frees it then. */
export const DEFAULT_LEASE_MS = 15 * 60_000;

export class ThreadBusyError extends Error {
  constructor(
    public readonly key: string,
    public readonly until?: Date,
  ) {
    super(
      `"${key}" is being run by another process right now${until ? ` (lease until ${until.toISOString()})` : ''}; try again when it has finished`,
    );
    this.name = 'ThreadBusyError';
  }
}

export type Release = () => Promise<void>;

/** A mutual-exclusion lease per key, shared by every process that uses the same store. */
export interface ThreadLock {
  /** Takes the lease or throws ThreadBusyError. */
  acquire(key: string): Promise<Release>;
  /** True while a live (unexpired) lease exists. */
  isHeld(key: string): Promise<boolean>;
}

export async function withLock<T>(lock: ThreadLock, key: string, fn: () => Promise<T>): Promise<T> {
  const release = await lock.acquire(key);
  try {
    return await fn();
  } finally {
    await release();
  }
}

interface LeaseDoc {
  _id: string;
  owner: string;
  expiresAt: Date;
  acquiredAt: Date;
}

/**
 * Lease in MongoDB. Acquire = upsert on `{ _id: key, expiresAt <= now }`: if a live lease exists the
 * filter does not match, the upsert tries to insert the same `_id`, and the unique `_id` index rejects
 * it (11000), which is "busy". Atomic across processes without transactions. Release sets the lease
 * to expired, only if we still own it.
 */
export class MongoThreadLock implements ThreadLock {
  private readonly leases: Collection<LeaseDoc>;

  constructor(
    db: Db,
    private readonly leaseMs: number = DEFAULT_LEASE_MS,
  ) {
    this.leases = db.collection<LeaseDoc>(LOCKS_COLLECTION);
  }

  async acquire(key: string): Promise<Release> {
    const owner = randomUUID();
    const now = new Date();
    try {
      await this.leases.updateOne(
        { _id: key, expiresAt: { $lte: now } },
        { $set: { owner, acquiredAt: now, expiresAt: new Date(now.getTime() + this.leaseMs) } },
        { upsert: true },
      );
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        const live = await this.leases.findOne({ _id: key });
        throw new ThreadBusyError(key, live?.expiresAt);
      }
      throw err;
    }
    return async () => {
      await this.leases.updateOne({ _id: key, owner }, { $set: { expiresAt: new Date(0) } });
    };
  }

  async isHeld(key: string): Promise<boolean> {
    return (
      (await this.leases.countDocuments(
        { _id: key, expiresAt: { $gt: new Date() } },
        { limit: 1 },
      )) > 0
    );
  }
}

/** Same semantics in one process (unit tests, evals). */
export class InMemoryThreadLock implements ThreadLock {
  private readonly held = new Map<string, string>();

  acquire(key: string): Promise<Release> {
    if (this.held.has(key)) return Promise.reject(new ThreadBusyError(key));
    const owner = randomUUID();
    this.held.set(key, owner);
    return Promise.resolve(() => {
      if (this.held.get(key) === owner) this.held.delete(key);
      return Promise.resolve();
    });
  }

  isHeld(key: string): Promise<boolean> {
    return Promise.resolve(this.held.has(key));
  }
}
