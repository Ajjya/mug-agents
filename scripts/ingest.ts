import { parseArgs } from 'node:util';
import {
  SPEAKERS_REPOSITORY,
  type SpeakersRepository,
} from '../src/repositories/speakers.repository.js';
import { AtlasVectorStore } from '../src/retrieval/atlas-vector.store.js';
import { CorpusError } from '../src/retrieval/corpus.js';
import { type Embedder, EmbeddingUnavailableError } from '../src/retrieval/embedder.js';
import { ingestCorpus } from '../src/retrieval/ingest.js';
import { EMBEDDER, VECTOR_STORE } from '../src/retrieval/retrieval.module.js';
import type { VectorStore } from '../src/retrieval/vector-store.js';
import { runCli } from './cli.js';

const { values } = parseArgs({ options: { corpus: { type: 'string', default: 'corpus/sample' } } });

runCli(
  async (app, config) => {
    const store = app.get<VectorStore>(VECTOR_STORE, { strict: false });
    const r = await ingestCorpus(values.corpus, {
      embedder: app.get<Embedder>(EMBEDDER, { strict: false }),
      stores: [store],
      speakers: app.get<SpeakersRepository>(SPEAKERS_REPOSITORY, { strict: false }),
    });
    if (store instanceof AtlasVectorStore) await store.ensureSearchIndexes(r.dim);
    console.log(
      `Ingested ${values.corpus} into the ${config.RETRIEVAL_STORE} store: ${String(r.documents)} documents, ${String(r.chunks)} chunks, ${String(r.tokens)} tokens embedded locally with ${r.model} (${String(r.dim)} dims).`,
    );
    return 0;
  },
  (err) =>
    err instanceof CorpusError || err instanceof EmbeddingUnavailableError
      ? (console.error(err.message), 2)
      : undefined,
);
