import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { isoDate, toStorage } from '../domain/common.js';
import {
  EventInputSchema,
  EventPatchSchema,
  EventSchema,
  type Event,
  type EventInput,
  type EventPatch,
  type EventPhase,
} from '../domain/event.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import {
  BaseRepository,
  type FindManyOptions,
  type Page,
  type Repository,
} from './base.repository.js';

export const EVENTS_REPOSITORY = Symbol('EVENTS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export interface EventsRepository extends Repository<EventInput, Event, EventPatch> {
  findByPhase(phase: EventPhase, options?: FindManyOptions): Promise<Page<Event>>;
  /** Events with `fromIso <= date < toIso` (half-open). Events without a date never match. */
  findByDateRange(fromIso: string, toIso: string, options?: FindManyOptions): Promise<Page<Event>>;
}

@Injectable()
export class MongoEventsRepository
  extends BaseRepository<typeof EventInputSchema, typeof EventSchema, typeof EventPatchSchema>
  implements EventsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.events), {
      input: EventInputSchema,
      doc: EventSchema,
      patch: EventPatchSchema,
    });
  }

  async findByPhase(phase: EventPhase, options?: FindManyOptions): Promise<Page<Event>> {
    // Re-validated at runtime: callers may be LLM-derived and must not smuggle in query operators.
    return await this.findWhere({ phase: EventInputSchema.shape.phase.parse(phase) }, options);
  }

  async findByDateRange(
    fromIso: string,
    toIso: string,
    options?: FindManyOptions,
  ): Promise<Page<Event>> {
    const from = toStorage(isoDate, fromIso);
    const to = toStorage(isoDate, toIso);
    return await this.findWhere({ date: { $gte: from, $lt: to } }, options);
  }
}
