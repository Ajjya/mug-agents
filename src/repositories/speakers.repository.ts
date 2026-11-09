import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { type EntityId, isEntityId, toObjectId } from '../domain/common.js';
import {
  SpeakerInputSchema,
  SpeakerPatchSchema,
  SpeakerSchema,
  type Speaker,
  type SpeakerInput,
  type SpeakerPatch,
} from '../domain/speaker.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import {
  BaseRepository,
  type FindManyOptions,
  type Page,
  type Repository,
} from './base.repository.js';

export const SPEAKERS_REPOSITORY = Symbol('SPEAKERS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export interface SpeakersRepository extends Repository<SpeakerInput, Speaker, SpeakerPatch> {
  /** Case-insensitive. Null when there is no such speaker or the email is not a valid address. */
  findByEmail(email: string): Promise<Speaker | null>;
  /** Speakers that have a `perEvent` entry for the event. Malformed ids match nothing. */
  findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Speaker>>;
}

/** The same normalisation the schema applies on write (trim/lower-case + format check). */
export function normaliseEmail(email: string): string | null {
  const emailSchema = SpeakerInputSchema.shape.email.unwrap();
  const result = emailSchema.safeParse(email.trim());
  return result.success ? result.data : null;
}

@Injectable()
export class MongoSpeakersRepository
  extends BaseRepository<typeof SpeakerInputSchema, typeof SpeakerSchema, typeof SpeakerPatchSchema>
  implements SpeakersRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.speakers), {
      input: SpeakerInputSchema,
      doc: SpeakerSchema,
      patch: SpeakerPatchSchema,
    });
  }

  async findByEmail(email: string): Promise<Speaker | null> {
    const normalised = normaliseEmail(email);
    if (normalised === null) return null;
    const page = await this.findWhere({ email: normalised }, { limit: 1 });
    return page.items[0] ?? null;
  }

  async findByEventId(eventId: EntityId, options?: FindManyOptions): Promise<Page<Speaker>> {
    if (!isEntityId(eventId)) return { items: [] };
    return this.findWhere({ 'perEvent.eventId': toObjectId(eventId) }, options);
  }
}
