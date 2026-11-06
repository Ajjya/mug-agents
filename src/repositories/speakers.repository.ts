import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import {
  SpeakerPatchSchema,
  SpeakerInputSchema,
  SpeakerSchema,
  type Speaker,
  type SpeakerInput,
  type SpeakerPatch,
} from '../domain/speaker.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import { BaseRepository, type Repository } from './base.repository.js';

export const SPEAKERS_REPOSITORY = Symbol('SPEAKERS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export type SpeakersRepository = Repository<SpeakerInput, Speaker, SpeakerPatch>;

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
}
