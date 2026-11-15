import type { Collection, Db, Filter } from 'mongodb';
import { assertCompatible, dot } from './embedder.js';
import { bm25 } from './scoring.js';
import {
  type Chunk,
  type Hit,
  type SearchQuery,
  type StoreStats,
  type VectorStore,
  collectionFor,
  fuseHybrid,
  stripVector,
  validateQuery,
} from './vector-store.js';

type StoredChunk = Omit<Chunk, 'id'> & { _id: string; retired: boolean; ingestedAt: Date };

const toChunk = (d: StoredChunk): Chunk => {
  const { _id, retired: _r, ingestedAt: _i, ...rest } = d;
  return { id: _id, ...rest };
};

/**
 * Chunks in an ordinary MongoDB collection; similarity computed in Node. Works on any mongod
 * (including mongodb-memory-server), so it is what the default test suite uses. The classification
 * scope is part of the MongoDB filter: out-of-scope chunks are never even loaded.
 */
export class BruteForceStore implements VectorStore {
  readonly name: string = 'bruteforce';
  private readonly col: Collection<StoredChunk>;

  constructor(db: Db, embedderRef: string) {
    this.col = db.collection<StoredChunk>(collectionFor(embedderRef));
  }

  async upsert(chunks: readonly Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const first = chunks[0];
    if (first) {
      const current = await this.stats();
      if (current.chunks > 0) assertCompatible(current, first);
      for (const c of chunks) assertCompatible(first, c);
    }
    const now = new Date();
    const byDoc = new Map<string, string[]>();
    for (const c of chunks) byDoc.set(c.documentId, [...(byDoc.get(c.documentId) ?? []), c.id]);
    // Retire chunks a document no longer produces (flag, never delete).
    for (const [documentId, ids] of byDoc) {
      await this.col.updateMany({ documentId, _id: { $nin: ids } }, { $set: { retired: true } });
    }
    await this.col.bulkWrite(
      chunks.map((c) => {
        const { id, ...rest } = c;
        return {
          replaceOne: {
            filter: { _id: id },
            replacement: { ...rest, _id: id, retired: false, ingestedAt: now },
            upsert: true,
          },
        };
      }),
    );
  }

  async stats(): Promise<StoreStats> {
    const live = { retired: false };
    const chunks = await this.col.countDocuments(live);
    const one = await this.col.findOne(live, { projection: { model: 1, dim: 1 } });
    return { chunks, model: one?.model ?? '', dim: one?.dim ?? 0 };
  }

  async search(q: SearchQuery): Promise<Hit[]> {
    validateQuery(q);
    const filter: Filter<StoredChunk> = {
      retired: false,
      classification: { $in: [...q.classification] },
      ...(q.kind ? { kind: q.kind } : {}),
    };
    const candidates = (await this.col.find(filter).toArray()).map(toChunk);
    const vector = (): Hit[] => {
      if (candidates.length === 0) return [];
      const first = candidates[0];
      if (first && q.queryModel) assertCompatible(first, q.queryModel);
      const v = q.vector ?? [];
      return candidates
        .map((c) => ({ chunk: stripVector(c), score: dot(c.vector, v) }))
        .filter((h) => h.score >= q.minScore)
        .sort((a, b) => b.score - a.score);
    };
    const keyword = (): Hit[] =>
      bm25(q.text, candidates, (c) => `${c.heading}\n${c.text}`).map((s) => ({
        chunk: stripVector(s.item),
        score: s.score,
      }));
    switch (q.strategy) {
      case 'vector':
        return vector().slice(0, q.limit);
      case 'keyword':
        return keyword().slice(0, q.limit);
      case 'hybrid':
        return fuseHybrid(vector(), keyword(), q.limit);
    }
  }
}
