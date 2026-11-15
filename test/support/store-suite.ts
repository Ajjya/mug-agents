import { beforeAll, describe, expect, it } from 'vitest';
import type { SpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { EmbeddingMismatchError } from '../../src/retrieval/embedder.js';
import { ingestCorpus } from '../../src/retrieval/ingest.js';
import { RetrievalService } from '../../src/retrieval/retrieval.service.js';
import { seedSpeakers } from '../../src/retrieval/seed-speakers.js';
import { STRATEGIES, type VectorStore } from '../../src/retrieval/vector-store.js';
import { StubEmbedder } from './stub-embedder.js';

export const SAMPLE = 'corpus/sample';
/** The stub embedder's bag-of-words cosines are lower than a real model's. */
export const STUB_MIN_SCORE = 0.25;

/**
 * Behaviour every VectorStore must have, run against BruteForceStore (default suite, memory server)
 * and AtlasVectorStore (opt-in, mongodb-atlas-local).
 */
export function storeSuite(
  name: string,
  setup: () => Promise<{
    store: VectorStore;
    speakers: SpeakersRepository;
    prepare?: (dim: number) => Promise<void>;
  }>,
): void {
  describe(`${name}: ingest and search the sample corpus`, () => {
    let store: VectorStore;
    let retrieval: RetrievalService;
    const embedder = new StubEmbedder();

    beforeAll(async () => {
      const s = await setup();
      store = s.store;
      await seedSpeakers(SAMPLE, s.speakers);
      const r = await ingestCorpus(SAMPLE, { embedder, stores: [store], speakers: s.speakers });
      await s.prepare?.(r.dim);
      retrieval = new RetrievalService(embedder, store, STUB_MIN_SCORE);
    }, 180_000);

    it('records model and dimension; returns hits with document ids, kinds and scores', async () => {
      expect(await store.stats()).toMatchObject({ model: 'stub-embed', dim: 256 });
      const hits = await retrieval.search('sharding shard key balancer', { strategy: 'keyword' });
      expect(hits[0]?.chunk).toMatchObject({
        documentId: 'abstracts/sharding-without-tears',
        kind: 'abstract',
      });
      expect(typeof hits[0]?.score).toBe('number');
      expect(hits[0]?.chunk.speakerHandle).toBe('otto-brambleworth');
      expect(hits[0]?.chunk).not.toHaveProperty('vector');
    });

    it.each(STRATEGIES)(
      'a public %s search never returns a personal chunk, even the best match',
      async (strategy) => {
        const q =
          'Bartholomew Nettlecombe forwarded question slides contact details personal phone';
        const publicHits = await retrieval.search(q, { strategy, limit: 10 });
        expect(publicHits.every((h) => h.chunk.classification === 'public')).toBe(true);
        expect(publicHits.map((h) => h.chunk.documentId)).not.toContain('notes/attendee-question');
        // ...and it IS the best match when personal content is asked for explicitly.
        const personal = await retrieval.search(q, { strategy, classification: ['personal'] });
        expect(personal[0]?.chunk.documentId).toBe('notes/attendee-question');
      },
    );

    it('filters by kind inside the query', async () => {
      const hits = await retrieval.search('host needed projector adapter attendee list', {
        kind: 'host_note',
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.chunk.kind === 'host_note')).toBe(true);
    });

    it('returns nothing (not the least-bad chunk) for a query with no relevant document', async () => {
      for (const strategy of STRATEGIES) {
        expect(
          await retrieval.search('kubernetes operator postgres failover', { strategy }),
        ).toEqual([]);
      }
    });

    it('refuses a query embedded with a different model or dimension', async () => {
      const other = new RetrievalService(
        new StubEmbedder('other-model', 256),
        store,
        STUB_MIN_SCORE,
      );
      await expect(other.search('sharding', { strategy: 'vector' })).rejects.toBeInstanceOf(
        EmbeddingMismatchError,
      );
      const wider = new RetrievalService(new StubEmbedder('stub-embed', 32), store, STUB_MIN_SCORE);
      await expect(wider.search('sharding', { strategy: 'vector' })).rejects.toBeInstanceOf(
        EmbeddingMismatchError,
      );
    });

    it('requires an explicit classification scope at the store', async () => {
      await expect(
        store.search({
          text: 'x',
          classification: [] as never,
          limit: 5,
          strategy: 'keyword',
          minScore: 0,
        }),
      ).rejects.toThrow(/classification scope/);
    });
  });
}
