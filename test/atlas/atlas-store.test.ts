import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { INDEXES } from '../../src/mongo/indexes.js';
import { MongoSpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { AtlasVectorStore } from '../../src/retrieval/atlas-vector.store.js';
import { storeSuite } from '../support/store-suite.js';
import { StubEmbedder } from '../support/stub-embedder.js';

/**
 * OPT-IN: the AtlasVectorStore arm against mongodb/mongodb-atlas-local (9.0+). Not part of `npm test`.
 *   npm run atlas:up && ATLAS_LOCAL_URI='mongodb://127.0.0.1:27018/?directConnection=true' npm run test:atlas
 * Gated twice: the ATLAS_LOCAL_URI flag, and the container's own healthcheck must say "healthy".
 */
const uri = process.env['ATLAS_LOCAL_URI'];
const container = process.env['ATLAS_LOCAL_CONTAINER'] ?? 'mug-atlas-local';

let client: MongoClient;
let db: Db;

describe.skipIf(!uri)('AtlasVectorStore on mongodb-atlas-local', () => {
  beforeAll(async () => {
    const health = execFileSync(
      'docker',
      ['inspect', '-f', '{{.State.Health.Status}}', container],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(health, `container ${container} must report healthy (npm run atlas:up)`).toBe('healthy');
    client = await new MongoClient(uri ?? '').connect();
    db = client.db(`atlas_test_${randomUUID().replaceAll('-', '')}`);
    await db.collection('speakers').createIndexes(INDEXES.speakers);
  }, 180_000);

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  storeSuite('AtlasVectorStore', () => {
    const store = new AtlasVectorStore(db, new StubEmbedder().ref);
    return Promise.resolve({
      store,
      speakers: new MongoSpeakersRepository(db),
      // mongot indexes asynchronously: wait until both indexes are queryable and have caught up.
      prepare: async (dim: number) => {
        await store.ensureSearchIndexes(dim);
        const deadline = Date.now() + 60_000;
        for (;;) {
          const hits = await store.search({
            text: 'sharding',
            classification: ['public'],
            limit: 1,
            strategy: 'keyword',
            minScore: 0,
          });
          if (hits.length > 0 || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 500));
        }
      },
    });
  });
});
