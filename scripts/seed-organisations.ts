import { parseArgs } from 'node:util';
import {
  ORGANISATIONS_REPOSITORY,
  type OrganisationsRepository,
} from '../src/repositories/organisations.repository.js';
import { seedOrganisations } from '../src/retrieval/seed-organisations.js';
import { runCli } from './cli.js';

const { values } = parseArgs({ options: { corpus: { type: 'string', default: 'corpus/sample' } } });

runCli(async (app) => {
  const r = await seedOrganisations(
    values.corpus,
    app.get<OrganisationsRepository>(ORGANISATIONS_REPOSITORY, { strict: false }),
  );
  console.log(
    `Seeded organisations from ${values.corpus}: ${String(r.created.length)} created, ${String(r.updated.length)} updated, ${String(r.unchanged.length)} unchanged.`,
  );
  return 0;
});
