import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import {
  OrganisationPatchSchema,
  OrganisationInputSchema,
  OrganisationSchema,
  type Organisation,
  type OrganisationInput,
  type OrganisationPatch,
} from '../domain/organisation.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import { BaseRepository, type Repository } from './base.repository.js';

export const ORGANISATIONS_REPOSITORY = Symbol('ORGANISATIONS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export type OrganisationsRepository = Repository<
  OrganisationInput,
  Organisation,
  OrganisationPatch
>;

@Injectable()
export class MongoOrganisationsRepository
  extends BaseRepository<
    typeof OrganisationInputSchema,
    typeof OrganisationSchema,
    typeof OrganisationPatchSchema
  >
  implements OrganisationsRepository
{
  constructor(@Inject(MONGO_DB) db: Db) {
    super(db.collection(COLLECTIONS.organisations), {
      input: OrganisationInputSchema,
      doc: OrganisationSchema,
      patch: OrganisationPatchSchema,
    });
  }
}
