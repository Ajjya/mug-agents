import { Logger } from '@nestjs/common';
import type { Collection, Document, Filter, ObjectId } from 'mongodb';
import type { z } from 'zod';
import {
  type EntityId,
  fromStorage,
  newEntityId,
  toObjectId,
  toStorage,
} from '../domain/common.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

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
 * agents never delete; state changes go through status fields.
 *
 * `filter` is a MongoDB filter over the *stored* representation (ObjectId / Date), see
 * `toObjectId` in domain/common.ts.
 */
export interface Repository<TInput, TDoc, TPatch> {
  insert(input: TInput): Promise<TDoc>;
  findById(id: EntityId): Promise<TDoc | null>;
  findMany(filter?: Filter<Document>, options?: FindManyOptions): Promise<Page<TDoc>>;
  /** Returns the updated document, or null if no document has that id. */
  updateById(id: EntityId, patch: TPatch): Promise<TDoc | null>;
  count(filter?: Filter<Document>): Promise<number>;
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

export class InvalidPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPatchError';
  }
}

type AnyObjectSchema = z.ZodObject;

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
> implements Repository<z.output<TInputSchema>, z.output<TDocSchema>, z.output<TPatchSchema>> {
  protected readonly logger: Logger;

  protected constructor(
    protected readonly collection: Collection,
    protected readonly schemas: RepositorySchemas<TInputSchema, TDocSchema, TPatchSchema>,
  ) {
    this.logger = new Logger(`${collection.collectionName}Repository`);
  }

  async insert(input: z.output<TInputSchema>): Promise<z.output<TDocSchema>> {
    // Validate the caller's input first so unknown fields (incl. _id/timestamps) are rejected.
    toStorage(this.schemas.input, input);
    const now = new Date().toISOString();
    // Timestamps and _id are set here, never by the caller. The strict schema rejects
    // any caller-supplied _id/createdAt/updatedAt in `input` before we get this far.
    const doc = { ...input, _id: newEntityId(), createdAt: now, updatedAt: now };
    const stored = toStorage(this.schemas.doc, doc as z.output<TDocSchema>);
    await this.collection.insertOne(stored);
    return this.read(stored);
  }

  async findById(id: EntityId): Promise<z.output<TDocSchema> | null> {
    const raw = await this.collection.findOne({ _id: toObjectId(id) });
    return raw ? this.read(raw) : null;
  }

  async findMany(
    filter: Filter<Document> = {},
    options: FindManyOptions = {},
  ): Promise<Page<z.output<TDocSchema>>> {
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
  ): Promise<z.output<TDocSchema> | null> {
    const stored = toStorage(this.schemas.patch, patch) as Record<string, unknown>;
    // `undefined` would be serialised as null by the driver; treat it as "not provided".
    const set = Object.fromEntries(Object.entries(stored).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) {
      throw new InvalidPatchError('Patch must contain at least one field');
    }
    const raw = await this.collection.findOneAndUpdate(
      { _id: toObjectId(id) },
      { $set: { ...set, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return raw ? this.read(raw) : null;
  }

  count(filter: Filter<Document> = {}): Promise<number> {
    return this.collection.countDocuments(filter);
  }

  /** Validate-on-read: schema drift is logged (id + issues, never the body) and thrown. */
  protected read(raw: Document): z.output<TDocSchema> {
    const result = fromStorage(this.schemas.doc, raw);
    if (result.success) return result.data;
    const id = (raw['_id'] as ObjectId | undefined)?.toString() ?? 'unknown';
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    this.logger.error(`schema drift in ${this.collection.collectionName} document ${id}`, {
      documentId: id,
      issues,
    });
    throw new SchemaDriftError(this.collection.collectionName, id, issues);
  }
}
