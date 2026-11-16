import type { Classification, CorpusKind } from './corpus.js';
import type { Embedder } from './embedder.js';
import type {
  ClassificationScope,
  Hit,
  RelevanceGates,
  SearchOutcome,
  SearchQuery,
  Strategy,
  VectorStore,
} from './vector-store.js';

export interface SearchOptions {
  kind?: CorpusKind;
  limit?: number;
  strategy?: Strategy;
  /** Defaults to public only. Personal content must be asked for explicitly. */
  classification?: ClassificationScope;
}

export const DEFAULT_SCOPE: readonly [Classification] = ['public'];

/** Generic search: embeds the query locally (unless keyword-only) and asks the store. */
export class RetrievalService {
  constructor(
    readonly embedder: Embedder,
    readonly store: VectorStore,
    readonly gates: RelevanceGates,
  ) {}

  async search(text: string, options: SearchOptions = {}): Promise<Hit[]> {
    return await this.store.search(await this.query(text, options));
  }

  /** The same search, with each arm's gate statistics (for the eval and for diagnosing a miss). */
  async explain(text: string, options: SearchOptions = {}): Promise<SearchOutcome> {
    return await this.store.explain(await this.query(text, options));
  }

  private async query(text: string, options: SearchOptions): Promise<SearchQuery> {
    const strategy = options.strategy ?? 'hybrid';
    const base: SearchQuery = {
      text,
      classification: options.classification ?? DEFAULT_SCOPE,
      limit: options.limit ?? 5,
      strategy,
      gates: this.gates,
      ...(options.kind ? { kind: options.kind } : {}),
    };
    if (strategy === 'keyword') return base;
    const e = await this.embedder.embedQuery(text);
    const vector = e.vectors[0];
    if (!vector) throw new Error('the embedder returned no vector for the query');
    return { ...base, vector, queryModel: { model: e.model, dim: e.dim } };
  }
}
