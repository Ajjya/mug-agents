import type { Classification, CorpusKind } from './corpus.js';
import type { Scored } from './scoring.js';
import { rrf } from './scoring.js';

/** A chunk as stored: text, provenance (citation + filters), and the embedding with its model. */
export interface Chunk {
  /** `${documentId}#${index}`. */
  id: string;
  documentId: string;
  index: number;
  heading: string;
  text: string;
  kind: CorpusKind;
  classification: Classification;
  /** YYYY-MM-DD from the manifest. */
  date: string;
  sourceUrl?: string;
  eventId?: string;
  organisationId?: string;
  /** Resolved from the manifest's speaker handle at ingest (read-only lookup). */
  speakerId?: string;
  speakerHandle?: string;
  /** `provider:model` of the embedder that produced `vector`. */
  embedder: string;
  model: string;
  dim: number;
  vector: number[];
}

/** What a search returns: the chunk without its vector, plus a score. */
export type ChunkView = Omit<Chunk, 'vector'>;

export interface Hit {
  chunk: ChunkView;
  /** vector: cosine (-1..1); keyword: the arm's own term score; hybrid: RRF score. */
  score: number;
}

export type Strategy = 'vector' | 'keyword' | 'hybrid';
export const STRATEGIES: readonly Strategy[] = ['vector', 'keyword', 'hybrid'];

/** At least one classification, always explicit: there is no value that means "everything". */
export type ClassificationScope = readonly [Classification, ...Classification[]];

export interface SearchQuery {
  text: string;
  /** Required for vector and hybrid. Must come from the same model/dim as the stored chunks. */
  vector?: number[];
  queryModel?: { model: string; dim: number };
  /** Mandatory scope, applied as a filter INSIDE the query (never by discarding hits afterwards). */
  classification: ClassificationScope;
  kind?: CorpusKind;
  limit: number;
  strategy: Strategy;
  /** Vector hits below this cosine are not relevant and are not returned. */
  minScore: number;
}

export interface StoreStats {
  chunks: number;
  /** Empty strings when the store holds no chunks yet. */
  model: string;
  dim: number;
}

export interface VectorStore {
  /** A short name for reports: `bruteforce` or `atlas`. */
  readonly name: string;
  /**
   * Writes the chunks of the documents in this batch. Chunks of those documents that are no longer
   * produced are retired (flagged, never deleted) and stop matching any search.
   */
  upsert(chunks: readonly Chunk[]): Promise<void>;
  search(query: SearchQuery): Promise<Hit[]>;
  stats(): Promise<StoreStats>;
}

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchQueryError';
  }
}

export function validateQuery(q: SearchQuery): void {
  if (!Array.isArray(q.classification) || q.classification.length === 0) {
    throw new SearchQueryError('a search must state its classification scope explicitly');
  }
  if (q.strategy !== 'keyword' && (!q.vector || !q.queryModel)) {
    throw new SearchQueryError(`${q.strategy} search needs a query vector and its model`);
  }
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) {
    throw new SearchQueryError('limit must be an integer between 1 and 100');
  }
}

/** Fuses an already scope-filtered vector list and keyword list. Items keep their chunk identity. */
export function fuseHybrid(vector: readonly Hit[], keyword: readonly Hit[], limit: number): Hit[] {
  const fused: Scored<Hit>[] = rrf([vector, keyword], (h) => h.chunk.id);
  return fused.slice(0, limit).map((s) => ({ chunk: s.item.chunk, score: s.score }));
}

/** One collection (and, on Atlas, one pair of indexes) per embedder: vector spaces never mix. */
export function collectionFor(embedderRef: string): string {
  return `chunks__${embedderRef.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

export function stripVector(c: Chunk): ChunkView {
  const { vector: _vector, ...view } = c;
  return view;
}
