import {
  ApprovalDecisionInputSchema,
  ApprovalDecisionPatchSchema,
  ApprovalDecisionSchema,
  type ApprovalDecision,
  ApprovalRequestInputSchema,
  ApprovalRequestPatchSchema,
  ApprovalRequestSchema,
  type ApprovalRequest,
  type ApprovalRequestStatus,
} from '../../src/approvals/approval.schema.js';
import type {
  ApprovalDecisionsRepository,
  ApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { z } from 'zod';
import {
  type EntityId,
  entityId,
  fromStorage,
  isEntityId,
  isoDate,
  newEntityId,
  toStorage,
} from '../../src/domain/common.js';
import {
  EventInputSchema,
  EventPatchSchema,
  EventSchema,
  type Event,
  type EventPhase,
} from '../../src/domain/event.schema.js';
import {
  OrganisationInputSchema,
  OrganisationPatchSchema,
  OrganisationSchema,
  type Organisation,
  type OrganisationKind,
} from '../../src/domain/organisation.schema.js';
import {
  SpeakerInputSchema,
  SpeakerPatchSchema,
  SpeakerSchema,
  type Speaker,
} from '../../src/domain/speaker.schema.js';
import {
  TaskInputSchema,
  TaskPatchSchema,
  TaskSchema,
  type Task,
  type TaskStatus,
} from '../../src/domain/task.schema.js';
import {
  DEFAULT_PAGE_SIZE,
  InvalidPatchError,
  MAX_PAGE_SIZE,
  DuplicateKeyError,
  VersionConflictError,
  updateWithRetry,
  type UpdateWithRetryOptions,
  type DocOf,
  type FindManyOptions,
  type Page,
  type Repository,
  type RepositorySchemas,
} from '../../src/repositories/base.repository.js';
import type { EventsRepository } from '../../src/repositories/events.repository.js';
import type { OrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import {
  normaliseEmail,
  type SpeakersRepository,
} from '../../src/repositories/speakers.repository.js';
import type { TasksRepository } from '../../src/repositories/tasks.repository.js';

type AnyObjectSchema = z.ZodObject;
type Doc = { _id: EntityId; version: number; createdAt: string; updatedAt: string };

/** Validate + normalise exactly like a write/read through MongoDB does (trim, lower-case, ...). */
function roundTrip<S extends AnyObjectSchema>(schema: S, value: z.output<S>): z.output<S> {
  const result = fromStorage(schema, toStorage(schema, value));
  if (!result.success) throw result.error;
  return result.data;
}

/**
 * In-memory implementation of the repository contract for tests of code that depends on the
 * interface (agent tools, graph nodes). It applies the same schemas and rules as the Mongo one;
 * test/integration/repositories.test.ts and test/unit/repositories.fake.test.ts run one shared
 * contract suite against both.
 */
export class InMemoryRepository<
  TInputSchema extends AnyObjectSchema,
  TDocSchema extends AnyObjectSchema,
  TPatchSchema extends AnyObjectSchema,
> implements Repository<z.output<TInputSchema>, DocOf<TDocSchema>, z.output<TPatchSchema>> {
  private readonly docs = new Map<string, DocOf<TDocSchema> & Doc>();

  constructor(
    private readonly schemas: RepositorySchemas<TInputSchema, TDocSchema, TPatchSchema>,
  ) {}

  async insert(input: z.output<TInputSchema>): Promise<DocOf<TDocSchema>> {
    toStorage(this.schemas.input, input);
    const now = new Date().toISOString();
    const doc = roundTrip(this.schemas.doc, {
      ...input,
      _id: newEntityId(),
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as DocOf<TDocSchema>) as DocOf<TDocSchema> & Doc;
    this.beforeWrite(doc, undefined);
    this.docs.set(doc._id, doc);
    return structuredClone(doc);
  }

  async findById(id: EntityId): Promise<DocOf<TDocSchema> | null> {
    const doc = isEntityId(id) ? this.docs.get(id.toLowerCase()) : undefined;
    return doc ? structuredClone(doc) : null;
  }

  async findMany(options: FindManyOptions = {}): Promise<Page<DocOf<TDocSchema>>> {
    return this.where(() => true, options);
  }

  async updateById(
    id: EntityId,
    patch: z.output<TPatchSchema>,
    expectedVersion: number,
  ): Promise<DocOf<TDocSchema> | null> {
    if (!isEntityId(id)) return null;
    const normalised = roundTrip(this.schemas.patch, patch) as Record<string, unknown>;
    const set = Object.fromEntries(Object.entries(normalised).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length === 0) {
      throw new InvalidPatchError('Patch must contain at least one field');
    }
    const current = this.docs.get(id.toLowerCase());
    if (!current) return null;
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(id, expectedVersion);
    }
    const next = roundTrip(this.schemas.doc, {
      ...current,
      ...set,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    }) as DocOf<TDocSchema> & Doc;
    this.beforeWrite(next, current);
    this.docs.set(next._id, next);
    return structuredClone(next);
  }

  updateWithRetry(
    id: EntityId,
    mutate: (doc: DocOf<TDocSchema>) => z.output<TPatchSchema> | Promise<z.output<TPatchSchema>>,
    options?: UpdateWithRetryOptions,
  ): Promise<DocOf<TDocSchema> | null> {
    return updateWithRetry<DocOf<TDocSchema>, z.output<TPatchSchema>>(this, id, mutate, options);
  }

  async count(): Promise<number> {
    return this.docs.size;
  }

  /** Hook for uniqueness rules that MongoDB enforces with indexes. */
  protected beforeWrite(
    _next: DocOf<TDocSchema> & Doc,
    _previous: (DocOf<TDocSchema> & Doc) | undefined,
  ): void {}

  protected all(): (DocOf<TDocSchema> & Doc)[] {
    return [...this.docs.values()];
  }

  protected where(
    predicate: (doc: DocOf<TDocSchema> & Doc) => boolean,
    options: FindManyOptions = {},
  ): Page<DocOf<TDocSchema>> {
    const requested = options.limit ?? DEFAULT_PAGE_SIZE;
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    const order = options.sort ?? 'asc';
    if (options.after !== undefined && !isEntityId(options.after)) {
      throw new Error(`Invalid entity id: ${JSON.stringify(options.after)}`);
    }
    const after = options.after?.toLowerCase();
    // ObjectId hex strings sort lexicographically in creation order.
    const matching = this.all()
      .filter(predicate)
      .sort((a, b) => (a._id < b._id ? -1 : 1) * (order === 'asc' ? 1 : -1))
      .filter((d) => after === undefined || (order === 'asc' ? d._id > after : d._id < after));
    const items = matching.slice(0, limit).map((d) => structuredClone(d));
    const last = items.at(-1);
    return matching.length > limit && last ? { items, nextCursor: last._id } : { items };
  }
}

export class InMemoryEventsRepository
  extends InMemoryRepository<typeof EventInputSchema, typeof EventSchema, typeof EventPatchSchema>
  implements EventsRepository
{
  constructor() {
    super({ input: EventInputSchema, doc: EventSchema, patch: EventPatchSchema });
  }
  async findByPhase(phase: EventPhase, options?: FindManyOptions): Promise<Page<Event>> {
    const valid = EventInputSchema.shape.phase.parse(phase);
    return this.where((d) => d.phase === valid, options);
  }
  async findByDateRange(
    fromIso: string,
    toIso: string,
    options?: FindManyOptions,
  ): Promise<Page<Event>> {
    const from = toStorage(isoDate, fromIso).getTime();
    const to = toStorage(isoDate, toIso).getTime();
    return this.where((d) => {
      if (d.date === undefined) return false;
      const t = new Date(d.date).getTime();
      return t >= from && t < to;
    }, options);
  }
}

export class InMemorySpeakersRepository
  extends InMemoryRepository<
    typeof SpeakerInputSchema,
    typeof SpeakerSchema,
    typeof SpeakerPatchSchema
  >
  implements SpeakersRepository
{
  constructor() {
    super({ input: SpeakerInputSchema, doc: SpeakerSchema, patch: SpeakerPatchSchema });
  }
  /** MongoDB enforces this with the unique sparse index on email. */
  protected override beforeWrite(next: Speaker): void {
    if (next.email === undefined) return;
    const clash = this.all().some((s) => s._id !== next._id && s.email === next.email);
    if (clash) throw new DuplicateKeyError('speakers', { email: 1 });
  }

  async findByEmail(email: string): Promise<Speaker | null> {
    const normalised = normaliseEmail(email);
    if (normalised === null) return null;
    return (
      (await this.findMany({ limit: MAX_PAGE_SIZE })).items.find((s) => s.email === normalised) ??
      null
    );
  }
  async findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Speaker>> {
    if (!isEntityId(eventId)) return { items: [] };
    const id = eventId.toLowerCase();
    return this.where((d) => d.perEvent.some((p) => p.eventId.toLowerCase() === id), options);
  }
}

export class InMemoryOrganisationsRepository
  extends InMemoryRepository<
    typeof OrganisationInputSchema,
    typeof OrganisationSchema,
    typeof OrganisationPatchSchema
  >
  implements OrganisationsRepository
{
  constructor() {
    super({
      input: OrganisationInputSchema,
      doc: OrganisationSchema,
      patch: OrganisationPatchSchema,
    });
  }
  async findByKind(kind: OrganisationKind, options?: FindManyOptions): Promise<Page<Organisation>> {
    const valid = OrganisationInputSchema.shape.kind.parse(kind);
    return this.where((d) => d.kind === valid, options);
  }
}

export class InMemoryTasksRepository
  extends InMemoryRepository<typeof TaskInputSchema, typeof TaskSchema, typeof TaskPatchSchema>
  implements TasksRepository
{
  constructor() {
    super({ input: TaskInputSchema, doc: TaskSchema, patch: TaskPatchSchema });
  }
  async findByStatus(status: TaskStatus, options?: FindManyOptions): Promise<Page<Task>> {
    const valid = TaskInputSchema.shape.status.parse(status);
    return this.where((d) => d.status === valid, options);
  }
  async findDueBefore(iso: string, options?: FindManyOptions): Promise<Page<Task>> {
    const limit = toStorage(isoDate, iso).getTime();
    return this.where((d) => d.dueAt !== undefined && new Date(d.dueAt).getTime() < limit, options);
  }
  async findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Task>> {
    toStorage(entityId, eventId); // same validation as the Mongo repository (throws ZodError)
    return this.where((d) => d.relatedEventId === eventId.toLowerCase(), options);
  }
}

export class InMemoryApprovalRequestsRepository
  extends InMemoryRepository<
    typeof ApprovalRequestInputSchema,
    typeof ApprovalRequestSchema,
    typeof ApprovalRequestPatchSchema
  >
  implements ApprovalRequestsRepository
{
  constructor() {
    super({
      input: ApprovalRequestInputSchema,
      doc: ApprovalRequestSchema,
      patch: ApprovalRequestPatchSchema,
    });
  }
  /** Same rule as the unique index (threadId, runId, nodeName). */
  protected override beforeWrite(
    next: ApprovalRequest,
    previous: ApprovalRequest | undefined,
  ): void {
    const clash = this.all().find(
      (d) =>
        d._id !== previous?._id &&
        d.threadId === next.threadId &&
        d.runId === next.runId &&
        d.nodeName === next.nodeName,
    );
    if (clash) {
      throw new DuplicateKeyError('approval_requests', { threadId: 1, runId: 1, nodeName: 1 });
    }
  }
  async findByStatus(
    status: ApprovalRequestStatus,
    options?: FindManyOptions,
  ): Promise<Page<ApprovalRequest>> {
    const valid = ApprovalRequestInputSchema.shape.status.parse(status);
    return this.where((d) => d.status === valid, options);
  }
  async findByKey(
    threadId: string,
    runId: string,
    nodeName: string,
  ): Promise<ApprovalRequest | null> {
    const nonEmptyText = z.string().min(1);
    nonEmptyText.parse(threadId);
    nonEmptyText.parse(runId);
    nonEmptyText.parse(nodeName);
    const found = this.where(
      (d) => d.threadId === threadId && d.runId === runId && d.nodeName === nodeName,
      { limit: 1 },
    );
    return found.items[0] ?? null;
  }
  async findByThread(threadId: string, options?: FindManyOptions): Promise<Page<ApprovalRequest>> {
    return this.where((d) => d.threadId === threadId, options);
  }
}

export class InMemoryApprovalDecisionsRepository
  extends InMemoryRepository<
    typeof ApprovalDecisionInputSchema,
    typeof ApprovalDecisionSchema,
    typeof ApprovalDecisionPatchSchema
  >
  implements ApprovalDecisionsRepository
{
  constructor() {
    super({
      input: ApprovalDecisionInputSchema,
      doc: ApprovalDecisionSchema,
      patch: ApprovalDecisionPatchSchema,
    });
  }
  /** Same rule as the unique index (requestId): one decision per request. */
  protected override beforeWrite(
    next: ApprovalDecision,
    previous: ApprovalDecision | undefined,
  ): void {
    if (this.all().some((d) => d._id !== previous?._id && d.requestId === next.requestId)) {
      throw new DuplicateKeyError('approval_decisions', { requestId: 1 });
    }
  }
  async findByRequestId(requestId: EntityId): Promise<ApprovalDecision | null> {
    toStorage(entityId, requestId);
    return (
      this.where((d) => d.requestId === requestId.toLowerCase(), { limit: 1 }).items[0] ?? null
    );
  }
}
