import { Module } from '@nestjs/common';
import type { Db } from 'mongodb';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { STRUCTURED_CALL } from '../llm/llm.module.js';
import type { StructuredCall } from '../llm/structured.js';
import { MongoModule } from '../mongo/mongo.module.js';
import { MONGO_DB } from '../mongo/tokens.js';
import { RepositoriesModule } from '../repositories/repositories.module.js';
import {
  SPEAKERS_REPOSITORY,
  type SpeakersRepository,
} from '../repositories/speakers.repository.js';
import { AtlasVectorStore } from './atlas-vector.store.js';
import { BruteForceStore } from './brute-force.store.js';
import { type Embedder, OllamaLocalEmbedder } from './embedder.js';
import { RetrievalService } from './retrieval.service.js';
import { SpeakerSuggester } from './suggest-speakers.js';
import type { VectorStore } from './vector-store.js';

export const EMBEDDER = Symbol('EMBEDDER');
export const VECTOR_STORE = Symbol('VECTOR_STORE');

@Module({
  imports: [MongoModule, RepositoriesModule],
  providers: [
    {
      provide: EMBEDDER,
      inject: [APP_CONFIG],
      // Local only: no text leaves the machine to be embedded. No network until first use.
      useFactory: (c: AppConfig) =>
        new OllamaLocalEmbedder(c.OLLAMA_LOCAL_BASE_URL, c.EMBEDDING_MODEL),
    },
    {
      provide: VECTOR_STORE,
      inject: [APP_CONFIG, MONGO_DB, EMBEDDER],
      useFactory: (c: AppConfig, db: Db, e: Embedder): VectorStore =>
        c.RETRIEVAL_STORE === 'atlas'
          ? new AtlasVectorStore(db, e.ref)
          : new BruteForceStore(db, e.ref),
    },
    {
      provide: RetrievalService,
      inject: [EMBEDDER, VECTOR_STORE, APP_CONFIG],
      useFactory: (e: Embedder, s: VectorStore, c: AppConfig) =>
        new RetrievalService(e, s, {
          minScore: c.VECTOR_MIN_SCORE,
          minGap: c.VECTOR_MIN_GAP,
          minCoverage: c.KEYWORD_MIN_COVERAGE,
        }),
    },
    {
      provide: SpeakerSuggester,
      inject: [RetrievalService, SPEAKERS_REPOSITORY, STRUCTURED_CALL],
      useFactory: (r: RetrievalService, s: SpeakersRepository, call: StructuredCall) =>
        new SpeakerSuggester(r, s, call),
    },
  ],
  exports: [EMBEDDER, VECTOR_STORE, RetrievalService, SpeakerSuggester],
})
export class RetrievalModule {}
