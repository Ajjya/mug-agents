import { Inject, Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import {
  OrganisationInputSchema,
  OrganisationPatchSchema,
  OrganisationSchema,
  type Organisation,
  type OrganisationInput,
  type OrganisationKind,
  type OrganisationPatch,
} from '../domain/organisation.schema.js';
import { COLLECTIONS } from '../mongo/indexes.js';
import { MONGO_DB } from '../mongo/tokens.js';
import {
  BaseRepository,
  type FindManyOptions,
  type Page,
  type Repository,
} from './base.repository.js';

export const ORGANISATIONS_REPOSITORY = Symbol('ORGANISATIONS_REPOSITORY');

/** What callers (and agent tools) depend on; swap in an in-memory fake in tests. */
export interface OrganisationsRepository extends Repository<
  OrganisationInput,
  Organisation,
  OrganisationPatch
> {
  findByKind(kind: OrganisationKind, options?: FindManyOptions): Promise<Page<Organisation>>;
  /** Exact match on the stored `name` and `kind`: the identity a seed file uses (there is no handle). */
  findByNameAndKind(name: string, kind: OrganisationKind): Promise<Organisation | null>;
}

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

  async findByKind(kind: OrganisationKind, options?: FindManyOptions): Promise<Page<Organisation>> {
    return await this.findWhere({ kind: OrganisationInputSchema.shape.kind.parse(kind) }, options);
  }

  async findByNameAndKind(name: string, kind: OrganisationKind): Promise<Organisation | null> {
    const page = await this.findWhere(
      {
        name: OrganisationInputSchema.shape.name.parse(name),
        kind: OrganisationInputSchema.shape.kind.parse(kind),
      },
      { limit: 1 },
    );
    return page.items[0] ?? null;
  }
}
