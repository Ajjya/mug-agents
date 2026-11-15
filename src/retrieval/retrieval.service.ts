import type { Classification, CorpusKind } from './corpus.js';
import type { Embedder } from './embedder.js';
import type { ClassificationScope, Hit, Strategy, VectorStore } from './vector-store.js';

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
    private readonly minScore: number,
  ) {}

  async search(text: string, options: SearchOptions = {}): Promise<Hit[]> {
    const strategy = options.strategy ?? 'hybrid';
    const base = {
      text,
      classification: options.classification ?? DEFAULT_SCOPE,
      limit: options.limit ?? 5,
      strategy,
      minScore: this.minScore,
      ...(options.kind ? { kind: options.kind } : {}),
    };
    if (strategy === 'keyword') return await this.store.search(base);
    const e = await this.embedder.embedQuery(text);
    const vector = e.vectors[0];
    if (!vector) throw new Error('the embedder returned no vector for the query');
    return await this.store.search({ ...base, vector, queryModel: { model: e.model, dim: e.dim } });
  }
}
