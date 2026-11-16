import type { Classification, CorpusKind } from './corpus.js';
import type { Scored } from './scoring.js';
import { rrf, terms } from './scoring.js';

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
  /** Each strategy's own no-answer rule. See {@link RelevanceGates}. */
  gates: RelevanceGates;
}

/**
 * How "nothing relevant" is decided, per arm, BEFORE anything is fused. An arm whose gate rejects a
 * hit drops it; hybrid only fuses what passed its own arm's gate, and the RRF score itself has no
 * threshold (it is a rank statistic, not a similarity, so a cosine threshold cannot apply to it).
 *
 *  - vector:  `minScore`, an absolute cosine (-1..1) per hit, calibrated per embedding model.
 *  - keyword: `minCoverage`, the share of the query's distinct terms (stopwords removed, light
 *             stemming) that the chunk contains. BM25 scores are not comparable across queries or
 *             corpora, so the keyword arm is gated on coverage, computed in Node the same way on
 *             both stores.
 *  - hybrid:  no gate of its own: the union of the two gated arms, fused by rank.
 */
export interface RelevanceGates {
  minScore: number;
  minCoverage: number;
}

/** Gates that let everything through: for probes and latency benchmarks, never for answers. */
export const OPEN_GATES: RelevanceGates = { minScore: -1, minCoverage: 0 };

/** What each arm saw and how many of its candidates passed its gate. */
export interface VectorArmReport {
  candidates: number;
  /** Best cosine among the candidates (null when there were none). */
  top: number | null;
  aboveMinScore: number;
}
export interface KeywordArmReport {
  /** Chunks that matched at least one query term. */
  candidates: number;
  topCoverage: number | null;
  aboveMinCoverage: number;
}
export interface SearchOutcome {
  hits: Hit[];
  /** Present when the strategy ran the vector arm. */
  vector?: VectorArmReport;
  /** Present when the strategy ran the keyword arm. */
  keyword?: KeywordArmReport;
}

/** How many candidates each arm retrieves before its gate (and the set the gate statistics use). */
export const candidateLimit = (limit: number): number => Math.max(limit, 50);

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
  /** The same search, with each arm's gate statistics: which gate rejected what. */
  explain(query: SearchQuery): Promise<SearchOutcome>;
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

/** Vector arm gate. `candidates` are the arm's raw results, best first, with cosine scores. */
export function gateVector(
  candidates: readonly Hit[],
  gates: RelevanceGates,
): { hits: Hit[]; report: VectorArmReport } {
  const hits = candidates.filter((h) => h.score >= gates.minScore);
  return {
    hits,
    report: {
      candidates: candidates.length,
      top: candidates[0]?.score ?? null,
      aboveMinScore: hits.length,
    },
  };
}

/** Share of the query's distinct terms that occur in the chunk's heading or text (0..1). */
export function termCoverage(query: string, chunk: Pick<ChunkView, 'heading' | 'text'>): number {
  const wanted = new Set(terms(query));
  if (wanted.size === 0) return 0;
  const present = new Set(terms(`${chunk.heading}\n${chunk.text}`));
  let found = 0;
  for (const t of wanted) if (present.has(t)) found++;
  return found / wanted.size;
}

/** Keyword arm gate. `candidates` are the arm's raw results in its own ranking order. */
export function gateKeyword(
  query: string,
  candidates: readonly Hit[],
  gates: RelevanceGates,
): { hits: Hit[]; report: KeywordArmReport } {
  const covered = candidates.map((h) => ({ h, coverage: termCoverage(query, h.chunk) }));
  const hits = covered.filter((x) => x.coverage >= gates.minCoverage).map((x) => x.h);
  return {
    hits,
    report: {
      candidates: candidates.length,
      topCoverage: covered.length === 0 ? null : Math.max(...covered.map((x) => x.coverage)),
      aboveMinCoverage: hits.length,
    },
  };
}

/**
 * The one place a search result is decided, for every store: gate each arm that ran, then return the
 * vector or keyword list, or fuse the two gated lists for hybrid.
 */
export function decide(
  q: SearchQuery,
  arms: { vector?: readonly Hit[]; keyword?: readonly Hit[] },
): SearchOutcome {
  const v = arms.vector ? gateVector(arms.vector, q.gates) : undefined;
  const k = arms.keyword ? gateKeyword(q.text, arms.keyword, q.gates) : undefined;
  const reports = {
    ...(v ? { vector: v.report } : {}),
    ...(k ? { keyword: k.report } : {}),
  };
  switch (q.strategy) {
    case 'vector':
      return { hits: (v?.hits ?? []).slice(0, q.limit), ...reports };
    case 'keyword':
      return { hits: (k?.hits ?? []).slice(0, q.limit), ...reports };
    case 'hybrid':
      return { hits: fuseHybrid(v?.hits ?? [], k?.hits ?? [], q.limit), ...reports };
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
