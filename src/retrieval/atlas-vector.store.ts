import type { Collection, Db, Document } from 'mongodb';
import { BruteForceStore } from './brute-force.store.js';
import { assertCompatible } from './embedder.js';
import {
  type ChunkView,
  type Hit,
  type SearchQuery,
  collectionFor,
  fuseHybrid,
  validateQuery,
} from './vector-store.js';

export const VECTOR_INDEX = 'chunks_vector';
export const TEXT_INDEX = 'chunks_text';

/**
 * The same collection layout as BruteForceStore (it inherits upsert and stats, so both arms hold the
 * same chunks and the same embeddings), searched through MongoDB Search instead of in Node:
 *  - vector: `$vectorSearch` on a `vectorSearch` index, the classification scope as a PRE-filter;
 *  - keyword: `$search` with `compound.must.text` and `compound.filter.in` on the scope.
 * Verified against mongodb/mongodb-atlas-local 9.0.4 (mongod 9.0.4, mongot 1.78.0).
 *
 * Vectors are unit length (normalised at embedding time), so `dotProduct` is the cosine; MongoDB
 * reports it as (1 + cosine) / 2 (verified), converted back so both arms share one scale.
 */
export class AtlasVectorStore extends BruteForceStore {
  override readonly name: string = 'atlas';
  private readonly raw: Collection;

  constructor(
    db: Db,
    embedderRef: string,
    private readonly pollMs = 1000,
  ) {
    super(db, embedderRef);
    this.raw = db.collection(collectionFor(embedderRef));
  }

  /** Creates both search indexes for `dim` if missing, then waits until they are queryable. */
  async ensureSearchIndexes(dim: number, timeoutMs = 120_000): Promise<void> {
    const existing = (await this.raw.listSearchIndexes().toArray()) as Document[];
    const names = new Set(existing.map((i) => i['name'] as string));
    const vectorIndex = existing.find((i) => i['name'] === VECTOR_INDEX);
    const indexedDim = (
      vectorIndex?.['latestDefinition'] as { fields?: { numDimensions?: number }[] } | undefined
    )?.fields?.find((f) => f.numDimensions !== undefined)?.numDimensions;
    if (indexedDim !== undefined && indexedDim !== dim) {
      throw new Error(
        `Index ${VECTOR_INDEX} is built for ${String(indexedDim)} dimensions, not ${String(dim)}; refusing to mix vector spaces`,
      );
    }
    if (!names.has(VECTOR_INDEX)) {
      await this.raw.createSearchIndex({
        name: VECTOR_INDEX,
        type: 'vectorSearch',
        definition: {
          fields: [
            {
              type: 'vector',
              path: 'vector',
              numDimensions: dim,
              similarity: 'dotProduct',
              quantization: 'none',
            },
            { type: 'filter', path: 'classification' },
            { type: 'filter', path: 'kind' },
            { type: 'filter', path: 'retired' },
          ],
        },
      });
    }
    if (!names.has(TEXT_INDEX)) {
      await this.raw.createSearchIndex({
        name: TEXT_INDEX,
        type: 'search',
        definition: {
          analyzer: 'lucene.english',
          mappings: {
            dynamic: false,
            fields: {
              text: [{ type: 'string' }],
              heading: [{ type: 'string' }],
              classification: [{ type: 'token' }],
              kind: [{ type: 'token' }],
              retired: [{ type: 'boolean' }],
            },
          },
        },
      });
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ix = (await this.raw.listSearchIndexes().toArray()) as Document[];
      const ready = [VECTOR_INDEX, TEXT_INDEX].every((n) =>
        ix.some((i) => i['name'] === n && i['queryable'] === true),
      );
      if (ready) return;
      if (Date.now() > deadline) throw new Error('search indexes did not become queryable in time');
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  override async search(q: SearchQuery): Promise<Hit[]> {
    validateQuery(q);
    const view = (d: Document): ChunkView => {
      const { _id, vector: _v, score: _s, retired: _r, ingestedAt: _i, ...rest } = d;
      return { id: _id as string, ...(rest as Omit<ChunkView, 'id'>) };
    };
    const scope = [...q.classification];

    const vector = async (): Promise<Hit[]> => {
      const stats = await this.stats();
      if (stats.chunks === 0) return [];
      if (q.queryModel) assertCompatible(stats, q.queryModel);
      const candidateLimit = Math.max(q.limit, 50);
      const docs = await this.raw
        .aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEX,
              path: 'vector',
              queryVector: q.vector,
              numCandidates: Math.min(10_000, candidateLimit * 20),
              limit: candidateLimit,
              filter: {
                $and: [
                  { classification: { $in: scope } },
                  { retired: false },
                  ...(q.kind ? [{ kind: q.kind }] : []),
                ],
              },
            },
          },
          { $project: { vector: 0 } },
          { $addFields: { score: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();
      return docs
        .map((d) => ({ chunk: view(d), score: 2 * (d['score'] as number) - 1 }))
        .filter((h) => h.score >= q.minScore);
    };

    const keyword = async (): Promise<Hit[]> => {
      const docs = await this.raw
        .aggregate([
          {
            $search: {
              index: TEXT_INDEX,
              compound: {
                must: [{ text: { query: q.text, path: ['text', 'heading'] } }],
                filter: [
                  { in: { path: 'classification', value: scope } },
                  { equals: { path: 'retired', value: false } },
                  ...(q.kind ? [{ equals: { path: 'kind', value: q.kind } }] : []),
                ],
              },
            },
          },
          { $limit: 50 },
          { $project: { vector: 0 } },
          { $addFields: { score: { $meta: 'searchScore' } } },
        ])
        .toArray();
      return docs.map((d) => ({ chunk: view(d), score: d['score'] as number }));
    };

    switch (q.strategy) {
      case 'vector':
        return (await vector()).slice(0, q.limit);
      case 'keyword':
        return (await keyword()).slice(0, q.limit);
      case 'hybrid':
        return fuseHybrid(await vector(), await keyword(), q.limit);
    }
  }
}
