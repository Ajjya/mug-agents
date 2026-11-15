import { parseArgs } from 'node:util';
import {
  SPEAKERS_REPOSITORY,
  type SpeakersRepository,
} from '../src/repositories/speakers.repository.js';
import { CorpusError } from '../src/retrieval/corpus.js';
import { seedSpeakers } from '../src/retrieval/seed-speakers.js';
import { runCli } from './cli.js';

const { values } = parseArgs({ options: { corpus: { type: 'string', default: 'corpus/sample' } } });

runCli(
  async (app) => {
    const r = await seedSpeakers(
      values.corpus,
      app.get<SpeakersRepository>(SPEAKERS_REPOSITORY, { strict: false }),
    );
    console.log(
      `Seeded speakers from ${values.corpus}: ${String(r.created.length)} created, ${String(r.updated.length)} updated, ${String(r.unchanged.length)} unchanged.`,
    );
    return 0;
  },
  (err) => (err instanceof CorpusError ? (console.error(err.message), 2) : undefined),
);
