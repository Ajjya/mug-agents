import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import {
  EventPatchSchema,
  EventInputSchema,
  EventSchema,
  type Event,
  type EventInput,
  type EventPatch,
} from '../domain/event.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import { BaseRepository, type Repository } from './base.repository.js';

export const EVENTS_REPOSITORY = Symbol('EVENTS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export type EventsRepository = Repository<EventInput, Event, EventPatch>;

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
}
