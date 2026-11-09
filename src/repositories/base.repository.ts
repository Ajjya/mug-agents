import { Logger } from '@nestjs/common';
import {
  MongoServerError,
  type Collection,
  type Document,
  type Filter,
  type ObjectId,
} from 'mongodb';
import type { z } from 'zod';
import {
  type EntityId,
  fromStorage,
  isEntityId,
  newEntityId,
  toObjectId,
  toStorage,
} from '../domain/common.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The fields every persisted document has that the contract itself relies on. */
export interface VersionedDoc {
  _id: EntityId;
  version: number;
}

export interface UpdateWithRetryOptions {
  /** Total tries (first attempt included). Default 3. */
  attempts?: number;
}

export interface FindManyOptions {
  /** Page size, 1..MAX_PAGE_SIZE. Defaults to DEFAULT_PAGE_SIZE. */
  limit?: number;
  /** Order by _id (creation order). Keyset pagination requires a stable sort key. */
  sort?: 'asc' | 'desc';
  /** Cursor: the `nextCursor` of the previous page. */
  after?: EntityId;
}

export interface Page<TDoc> {
  items: TDoc[];
  /** Pass as `after` to get the next page; undefined when there are no more results. */
  nextCursor?: EntityId;
}

/**
 * The contract agents' tools and tests depend on. Intentionally has no delete method:
 * agents never delete; state changes go through status fields. It is storage-agnostic: ids and
 * dates are domain strings, and there are no MongoDB types. Queries beyond these basics are typed
 * finders on each entity's repository interface.
 */
export interface Repository<TInput, TDoc extends VersionedDoc, TPatch> {
  insert(input: TInput): Promise<TDoc>;
  findById(id: EntityId): Promise<TDoc | null>;
  findMany(options?: FindManyOptions): Promise<Page<TDoc>>;
  /**
   * Optimistic locking: `expectedVersion` is the `version` of the document the caller read.
   * Returns the updated document (version + 1), or null if no document has that id.
   * Throws VersionConflictError if the document changed since it was read; re-read and retry.
   */
  updateById(id: EntityId, patch: TPatch, expectedVersion: number): Promise<TDoc | null>;
  count(): Promise<number>;
  /**
   * Read-modify-write that survives concurrent writers: re-reads the document, applies
   * `mutate(doc) => patch`, calls updateById with the fresh version, and retries on
   * VersionConflictError up to `attempts` times (then rethrows it). Returns null if the id does
   * not exist. `mutate` runs once per attempt, so it must be pure / free of side effects.
   *
   * Use this, not updateById, from anything that holds a document across a pause (LangGraph
   * nodes resumed after interrupt(), tools that call an LLM between read and write): the version
   * captured before the pause is probably stale by the time the node resumes.
   */
  updateWithRetry(
    id: EntityId,
    mutate: (doc: TDoc) => TPatch | Promise<TPatch>,
    options?: UpdateWithRetryOptions,
  ): Promise<TDoc | null>;
}

/** Thrown when a stored document no longer matches its schema. This is a bug, not user error. */
export class SchemaDriftError extends Error {
  constructor(
    public readonly collection: string,
    public readonly documentId: string,
    public readonly issues: readonly string[],
  ) {
    super(`Stored ${collection} document ${documentId} does not match its schema`);
    this.name = 'SchemaDriftError';
  }
}

export class VersionConflictError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly expectedVersion: number,
  ) {
    super(`Document ${documentId} is no longer at version ${String(expectedVersion)}`);
    this.name = 'VersionConflictError';
  }
}

/** A write violated a unique index (MongoDB error 11000). `keyPattern` names the index keys. */
export class DuplicateKeyError extends Error {
  constructor(
    public readonly collection: string,
    public readonly keyPattern: Readonly<Record<string, unknown>>,
  ) {
    // The conflicting value is deliberately not included: it may be personal data (an email).
    super(`Duplicate key in ${collection} on ${JSON.stringify(Object.keys(keyPattern))}`);
    this.name = 'DuplicateKeyError';
  }
}

export class InvalidPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPatchError';
  }
}

/** Shared by the Mongo base class and the in-memory fake so both retry identically. */
export async function updateWithRetry<TDoc extends VersionedDoc, TPatch>(
  repo: Pick<Repository<unknown, TDoc, TPatch>, 'findById' | 'updateById'>,
  id: EntityId,
  mutate: (doc: TDoc) => TPatch | Promise<TPatch>,
  { attempts = 3 }: UpdateWithRetryOptions = {},
): Promise<TDoc | null> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts must be an integer >= 1, got ${String(attempts)}`);
  }
  let lastConflict: VersionConflictError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const doc = await repo.findById(id);
    if (!doc) return null;
    const patch = await mutate(doc);
    try {
      return await repo.updateById(id, patch, doc.version);
    } catch (err) {
      if (!(err instanceof VersionConflictError)) throw err;
      lastConflict = err;
    }
  }
  throw lastConflict ?? new RangeError('unreachable');
}

type AnyObjectSchema = z.ZodObject;

/** Domain document type for a document schema (the persisted shape always has _id + version). */
export type DocOf<S extends AnyObjectSchema> = z.output<S> & VersionedDoc;

export interface RepositorySchemas<
  TInputSchema extends AnyObjectSchema,
  TDocSchema extends AnyObjectSchema,
  TPatchSchema extends AnyObjectSchema,
> {
  input: TInputSchema;
  doc: TDocSchema;
  patch: TPatchSchema;
}

export abstract class BaseRepository<
  TInputSchema extends AnyObjectSchema,
  TDocSchema extends AnyObjectSchema,
  TPatchSchema extends AnyObjectSchema,
> implements Repository<z.output<TInputSchema>, DocOf<TDocSchema>, z.output<TPatchSchema>> {
  protected readonly logger: Logger;

  protected constructor(
    protected readonly collection: Collection,
    protected readonly schemas: RepositorySchemas<TInputSchema, TDocSchema, TPatchSchema>,
  ) {
    this.logger = new Logger(`${collection.collectionName}Repository`);
  }

  async insert(input: z.output<TInputSchema>): Promise<DocOf<TDocSchema>> {
    // Validate the caller's input first so unknown fields (incl. _id/timestamps) are rejected.
    toStorage(this.schemas.input, input);
    const now = new Date().toISOString();
    // Timestamps and _id are set here, never by the caller. The strict schema rejects
    // any caller-supplied _id/createdAt/updatedAt in `input` before we get this far.
    const doc = { ...input, _id: newEntityId(), version: 1, createdAt: now, updatedAt: now };
    const stored = toStorage(this.schemas.doc, doc as DocOf<TDocSchema>);
    await this.mapDuplicateKey(() => this.collection.insertOne(stored));
    return this.read(stored);
  }

  async findById(id: EntityId): Promise<DocOf<TDocSchema> | null> {
    if (!isEntityId(id)) return null; // a malformed id cannot exist
    const raw = await this.collection.findOne({ _id: toObjectId(id) });
    return raw ? this.read(raw) : null;
  }

  findMany(options: FindManyOptions = {}): Promise<Page<DocOf<TDocSchema>>> {
    return this.findWhere({}, options);
  }

  /**
   * Keyset-paginated query. `filter` is over the *stored* representation (ObjectId / Date), so it
   * stays inside the repository: public access goes through typed finders that convert domain
   * values first.
   */
  protected async findWhere(
    filter: Filter<Document>,
    options: FindManyOptions = {},
  ): Promise<Page<DocOf<TDocSchema>>> {
    const requested = options.limit ?? DEFAULT_PAGE_SIZE;
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    const order = options.sort ?? 'asc';
    const query: Filter<Document> = options.after
      ? {
          $and: [filter, { _id: { [order === 'asc' ? '$gt' : '$lt']: toObjectId(options.after) } }],
        }
      : filter;
    // Fetch one extra row to know whether another page exists, without a count query.
    const raws = await this.collection
      .find(query)
      .sort({ _id: order === 'asc' ? 1 : -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = raws.length > limit;
    const items = raws.slice(0, limit).map((raw) => this.read(raw));
    const last = items.at(-1) as { _id: EntityId } | undefined;
    return hasMore && last ? { items, nextCursor: last._id } : { items };
  }

  async updateById(
    id: EntityId,
    patch: z.output<TPatchSchema>,
    expectedVersion: number,
  ): Promise<DocOf<TDocSchema> | null> {
    if (!isEntityId(id)) return null;
    const stored = toStorage(this.schemas.patch, patch) as Record<string, unknown>;
    // `undefined` would be serialised as null by the driver; treat it as "not provided".
    const set = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) {
      throw new InvalidPatchError('Patch must contain at least one field');
    }
    const _id = toObjectId(id);
    const raw = await this.mapDuplicateKey(() =>
      this.collection.findOneAndUpdate(
        { _id, version: expectedVersion },
        { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      ),
    );
    if (raw) return this.read(raw);
    // No match: either the id does not exist, or the version moved on.
    if ((await this.collection.countDocuments({ _id }, { limit: 1 })) > 0) {
      throw new VersionConflictError(id, expectedVersion);
    }
    return null;
  }

  count(): Promise<number> {
    return this.countWhere({});
  }

  updateWithRetry(
    id: EntityId,
    mutate: (doc: DocOf<TDocSchema>) => z.output<TPatchSchema> | Promise<z.output<TPatchSchema>>,
    options?: UpdateWithRetryOptions,
  ): Promise<DocOf<TDocSchema> | null> {
    return updateWithRetry<DocOf<TDocSchema>, z.output<TPatchSchema>>(this, id, mutate, options);
  }

  protected countWhere(filter: Filter<Document>): Promise<number> {
    return this.collection.countDocuments(filter);
  }

  /** Translate MongoDB's duplicate-key error (11000) into the storage-agnostic DuplicateKeyError. */
  private async mapDuplicateKey<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        const keyPattern = err['keyPattern'] as Record<string, unknown> | undefined;
        throw new DuplicateKeyError(this.collection.collectionName, keyPattern ?? {});
      }
      throw err;
    }
  }

  /** Validate-on-read: schema drift is logged (id + issues, never the body) and thrown. */
  protected read(raw: Document): DocOf<TDocSchema> {
    const result = fromStorage(this.schemas.doc, raw);
    // Every document schema is built with documentShape, so _id and version are guaranteed.
    if (result.success) return result.data as DocOf<TDocSchema>;
    const id = (raw['_id'] as ObjectId | undefined)?.toString() ?? 'unknown';
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    this.logger.error(`schema drift in ${this.collection.collectionName} document ${id}`, {
      documentId: id,
      issues,
    });
    throw new SchemaDriftError(this.collection.collectionName, id, issues);
  }
}
