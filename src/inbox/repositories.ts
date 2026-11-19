import { Inject, Injectable, Logger } from '@nestjs/common';
import { MongoServerError, type Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  type EntityId,
  fromStorage,
  isEntityId,
  newEntityId,
  toObjectId,
  toStorage,
  documentShape,
} from '../domain/common.js';
import {
  AdmittedThreadInputSchema,
  AdmittedThreadPatchSchema,
  AdmittedThreadSchema,
  CandidateThreadInputSchema,
  CandidateThreadPatchSchema,
  CandidateThreadSchema,
  ContactInputSchema,
  ContactPatchSchema,
  ContactSchema,
  ExcludedThreadInputSchema,
  ExcludedThreadPatchSchema,
  ExcludedThreadSchema,
  InboundMessageInputSchema,
  InboundMessagePatchSchema,
  InboundMessageViewSchema,
  InboxCursorInputSchema,
  InboxCursorPatchSchema,
  InboxCursorSchema,
  type AdmittedThread,
  type AdmittedThreadInput,
  type CandidateThread,
  type CandidateThreadInput,
  type Contact,
  type ContactInput,
  type ExcludedThread,
  type ExcludedThreadInput,
  type InboundMessage,
  type InboundMessageInput,
  type InboundMessagePatch,
  type FolderCursor,
  type InboxCursor,
} from '../domain/inbox.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import {
  BaseRepository,
  DuplicateKeyError,
  SchemaDriftError,
  type FindManyOptions,
  type Page,
  type Repository,
} from '../repositories/base.repository.js';

export const INBOUND_MESSAGES_REPOSITORY = Symbol('INBOUND_MESSAGES_REPOSITORY');
export const ADMITTED_THREADS_REPOSITORY = Symbol('ADMITTED_THREADS_REPOSITORY');
export const EXCLUDED_THREADS_REPOSITORY = Symbol('EXCLUDED_THREADS_REPOSITORY');
export const CANDIDATE_THREADS_REPOSITORY = Symbol('CANDIDATE_THREADS_REPOSITORY');
export const CONTACTS_REPOSITORY = Symbol('CONTACTS_REPOSITORY');
export const INBOX_CURSOR_REPOSITORY = Symbol('INBOX_CURSOR_REPOSITORY');

// ---- inbound messages: the raw body is behind one explicit method -------------------------------

/**
 * No delete, and no read returns `bodyText`. `getRawBody` is the ONLY way to get it, and a source scan
 * (test/unit/inbox-raw-body.test.ts) fails if anything outside the inbox module and the inbox CLI
 * mentions it. Everything downstream consumes the validated triage summary and domain fields.
 */
export interface InboundMessagesRepository {
  /** A second insert of the same gmailId is a no-op that returns the stored message. */
  insert(input: InboundMessageInput): Promise<{ message: InboundMessage; created: boolean }>;
  findById(id: EntityId): Promise<InboundMessage | null>;
  findByGmailId(gmailId: string): Promise<InboundMessage | null>;
  /** Which of these Gmail ids are already stored (the sweep's diff). */
  knownGmailIds(ids: readonly string[]): Promise<Set<string>>;
  findByThreadId(threadId: string): Promise<InboundMessage[]>;
  findByTriageState(state: 'pending' | 'failed', limit: number): Promise<InboundMessage[]>;
  findRecent(limit: number): Promise<InboundMessage[]>;
  update(id: EntityId, patch: InboundMessagePatch): Promise<InboundMessage | null>;
  getRawBody(id: EntityId): Promise<string | null>;
  count(): Promise<number>;
}

const FullInboundSchema = InboundMessageInputSchema.extend(documentShape);

@Injectable()
export class MongoInboundMessagesRepository implements InboundMessagesRepository {
  private readonly logger = new Logger('InboundMessagesRepository');
  private readonly col;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.col = db.collection(COLLECTIONS.inboundMessages);
  }

  private static readonly NO_BODY = { projection: { bodyText: 0 } } as const;

  private read(raw: Record<string, unknown>): InboundMessage {
    const result = fromStorage(InboundMessageViewSchema, raw);
    if (result.success) return result.data;
    const id = (raw['_id'] as ObjectId | undefined)?.toString() ?? 'unknown';
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    // Id and issues only: never the body, a subject or an address.
    this.logger.error(`schema drift in inbound_messages document ${id}`, { id, issues });
    throw new SchemaDriftError(COLLECTIONS.inboundMessages, id, issues);
  }

  async insert(input: InboundMessageInput): Promise<{ message: InboundMessage; created: boolean }> {
    toStorage(InboundMessageInputSchema, input); // strict: unknown fields refused
    const now = new Date().toISOString();
    const doc = { ...input, _id: newEntityId(), version: 1, createdAt: now, updatedAt: now };
    const stored = toStorage(FullInboundSchema, doc);
    try {
      await this.col.insertOne(stored);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        const existing = await this.findByGmailId(input.gmailId);
        if (!existing) throw new DuplicateKeyError(COLLECTIONS.inboundMessages, { gmailId: 1 });
        return { message: existing, created: false };
      }
      throw err;
    }
    const rest: Record<string, unknown> = { ...stored };
    delete rest['bodyText'];
    return { message: this.read(rest), created: true };
  }

  async findById(id: EntityId): Promise<InboundMessage | null> {
    if (!isEntityId(id)) return null;
    const raw = await this.col.findOne(
      { _id: toObjectId(id) },
      MongoInboundMessagesRepository.NO_BODY,
    );
    return raw ? this.read(raw) : null;
  }

  async findByGmailId(gmailId: string): Promise<InboundMessage | null> {
    const raw = await this.col.findOne(
      { gmailId: z.string().min(1).parse(gmailId) },
      MongoInboundMessagesRepository.NO_BODY,
    );
    return raw ? this.read(raw) : null;
  }

  async knownGmailIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const found = await this.col
      .find({ gmailId: { $in: [...ids] } }, { projection: { gmailId: 1 } })
      .toArray();
    return new Set(found.map((d) => String(d['gmailId'])));
  }

  private async many(filter: object, limit: number): Promise<InboundMessage[]> {
    const raws = await this.col
      .find(filter, MongoInboundMessagesRepository.NO_BODY)
      .sort({ _id: 1 })
      .limit(limit)
      .toArray();
    return raws.map((r) => this.read(r));
  }

  findByThreadId(threadId: string): Promise<InboundMessage[]> {
    return this.many({ threadId: z.string().min(1).parse(threadId) }, 500);
  }

  findByTriageState(state: 'pending' | 'failed', limit: number): Promise<InboundMessage[]> {
    return this.many({ triageState: state }, limit);
  }

  async findRecent(limit: number): Promise<InboundMessage[]> {
    const raws = await this.col
      .find({}, MongoInboundMessagesRepository.NO_BODY)
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();
    return raws.map((r) => this.read(r)).reverse();
  }

  async update(id: EntityId, patch: InboundMessagePatch): Promise<InboundMessage | null> {
    if (!isEntityId(id)) return null;
    const set = Object.fromEntries(
      Object.entries(toStorage(InboundMessagePatchSchema, patch) as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      ),
    );
    if (Object.keys(set).length === 0) return await this.findById(id);
    const raw = await this.col.findOneAndUpdate(
      { _id: toObjectId(id) },
      { $set: { ...set, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after', ...MongoInboundMessagesRepository.NO_BODY },
    );
    return raw ? this.read(raw) : null;
  }

  async getRawBody(id: EntityId): Promise<string | null> {
    if (!isEntityId(id)) return null;
    const raw = await this.col.findOne({ _id: toObjectId(id) }, { projection: { bodyText: 1 } });
    return raw ? String(raw['bodyText'] ?? '') : null;
  }

  count(): Promise<number> {
    return this.col.countDocuments({});
  }
}

// ---- threads, contacts, cursor ------------------------------------------------------------------

export interface AdmittedThreadsRepository extends Repository<
  AdmittedThreadInput,
  AdmittedThread,
  Record<string, never>
> {
  findByThreadId(threadId: string): Promise<AdmittedThread | null>;
  findRecent(limit: number): Promise<AdmittedThread[]>;
}
export interface ExcludedThreadsRepository extends Repository<
  ExcludedThreadInput,
  ExcludedThread,
  Partial<Pick<ExcludedThread, 'status' | 'liftedAt' | 'reason' | 'excludedAt'>>
> {
  findByThreadId(threadId: string): Promise<ExcludedThread | null>;
}
export interface CandidateThreadsRepository extends Repository<
  CandidateThreadInput,
  CandidateThread,
  Partial<Pick<CandidateThread, 'state' | 'reason' | 'decidedAt' | 'lastSeenAt'>>
> {
  findByThreadId(threadId: string): Promise<CandidateThread | null>;
  findByState(
    state: CandidateThread['state'],
    options?: FindManyOptions,
  ): Promise<Page<CandidateThread>>;
}
export interface ContactsRepository extends Repository<
  ContactInput,
  Contact,
  Partial<Pick<Contact, 'name' | 'role' | 'speakerId' | 'organisationId'>>
> {
  findByAddress(address: string): Promise<Contact | null>;
}
export interface InboxCursorRepository extends Repository<
  { key: 'gmail'; folders?: FolderCursor[]; lastPollAt?: string; lastUidValidityResetAt?: string },
  InboxCursor,
  Partial<Pick<InboxCursor, 'folders' | 'lastPollAt' | 'lastUidValidityResetAt'>>
> {
  get(): Promise<InboxCursor | null>;
}

const text = z.string().min(1);

@Injectable()
export class MongoAdmittedThreadsRepository
  extends BaseRepository<
    typeof AdmittedThreadInputSchema,
    typeof AdmittedThreadSchema,
    typeof AdmittedThreadPatchSchema
  >
  implements AdmittedThreadsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.admittedThreads), {
      input: AdmittedThreadInputSchema,
      doc: AdmittedThreadSchema,
      patch: AdmittedThreadPatchSchema,
    });
  }
  async findByThreadId(threadId: string) {
    return (
      (await this.findWhere({ threadId: text.parse(threadId) }, { limit: 1 })).items[0] ?? null
    );
  }
  async findRecent(limit: number) {
    return (await this.findWhere({}, { limit, sort: 'desc' })).items;
  }
}

@Injectable()
export class MongoExcludedThreadsRepository
  extends BaseRepository<
    typeof ExcludedThreadInputSchema,
    typeof ExcludedThreadSchema,
    typeof ExcludedThreadPatchSchema
  >
  implements ExcludedThreadsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.excludedThreads), {
      input: ExcludedThreadInputSchema,
      doc: ExcludedThreadSchema,
      patch: ExcludedThreadPatchSchema,
    });
  }
  async findByThreadId(threadId: string) {
    return (
      (await this.findWhere({ threadId: text.parse(threadId) }, { limit: 1 })).items[0] ?? null
    );
  }
}

@Injectable()
export class MongoCandidateThreadsRepository
  extends BaseRepository<
    typeof CandidateThreadInputSchema,
    typeof CandidateThreadSchema,
    typeof CandidateThreadPatchSchema
  >
  implements CandidateThreadsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.candidateThreads), {
      input: CandidateThreadInputSchema,
      doc: CandidateThreadSchema,
      patch: CandidateThreadPatchSchema,
    });
  }
  async findByThreadId(threadId: string) {
    return (
      (await this.findWhere({ threadId: text.parse(threadId) }, { limit: 1 })).items[0] ?? null
    );
  }
  async findByState(state: CandidateThread['state'], options?: FindManyOptions) {
    return await this.findWhere(
      { state: CandidateThreadInputSchema.shape.state.parse(state) },
      options,
    );
  }
}

@Injectable()
export class MongoContactsRepository
  extends BaseRepository<typeof ContactInputSchema, typeof ContactSchema, typeof ContactPatchSchema>
  implements ContactsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.contacts), {
      input: ContactInputSchema,
      doc: ContactSchema,
      patch: ContactPatchSchema,
    });
  }
  async findByAddress(address: string) {
    const normalised = ContactInputSchema.shape.address.safeParse(address.trim());
    if (!normalised.success) return null;
    return (await this.findWhere({ address: normalised.data }, { limit: 1 })).items[0] ?? null;
  }
}

@Injectable()
export class MongoInboxCursorRepository
  extends BaseRepository<
    typeof InboxCursorInputSchema,
    typeof InboxCursorSchema,
    typeof InboxCursorPatchSchema
  >
  implements InboxCursorRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.inboxCursor), {
      input: InboxCursorInputSchema,
      doc: InboxCursorSchema,
      patch: InboxCursorPatchSchema,
    });
  }
  async get() {
    return (await this.findWhere({ key: 'gmail' }, { limit: 1 })).items[0] ?? null;
  }
}
