export interface Embedding {
  vectors: number[][];
  /** Tokens the model actually processed (prompt_eval_count). */
  tokens: number;
  model: string;
  /** Read from the response, never assumed. */
  dim: number;
}

/**
 * The one interface the retrieval layer depends on. Today there is one implementation, a LOCAL
 * Ollama model: no text leaves the machine to be embedded (docs/data-handling.md). Tests stub it.
 */
export interface Embedder {
  /** `provider:model`, e.g. `ollama-local:nomic-embed-text`. Keys the chunk set and the report. */
  readonly ref: string;
  readonly model: string;
  embedDocuments(texts: readonly string[]): Promise<Embedding>;
  embedQuery(text: string): Promise<Embedding>;
}

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

/**
 * A query embedded with one model/dimension compared against vectors from another produces plausible
 * nonsense with no error. Refuse instead.
 */
export class EmbeddingMismatchError extends Error {
  constructor(
    public readonly stored: { model: string; dim: number },
    public readonly query: { model: string; dim: number },
  ) {
    super(
      `Embedding mismatch: the index holds ${stored.model} (${String(stored.dim)} dims) but the query was embedded with ${query.model} (${String(query.dim)} dims). Re-ingest with the query's model or query with the index's model.`,
    );
    this.name = 'EmbeddingMismatchError';
  }
}

export function assertCompatible(
  stored: { model: string; dim: number },
  query: { model: string; dim: number },
): void {
  if (stored.model !== query.model || stored.dim !== query.dim) {
    throw new EmbeddingMismatchError(stored, query);
  }
}

/** Unit length, so a dot product is the cosine on both stores. */
export function normalize(v: readonly number[]): number[] {
  const n = Math.hypot(...v);
  if (!Number.isFinite(n) || n === 0) throw new RangeError('cannot normalise a zero vector');
  return v.map((x) => x / n);
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/**
 * nomic-embed-text is trained with task prefixes; without them retrieval quality drops. Other models
 * get the text as is.
 */
function prefixesFor(model: string): { document: string; query: string } {
  return model.startsWith('nomic-embed')
    ? { document: 'search_document: ', query: 'search_query: ' }
    : { document: '', query: '' };
}

const BATCH = 32;

/** Local Ollama embeddings (`POST /api/embed`). Called with truncate=false: overflow fails loudly. */
export class OllamaLocalEmbedder implements Embedder {
  readonly ref: string;
  private readonly prefixes: { document: string; query: string };

  constructor(
    private readonly baseUrl: string,
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.ref = `ollama-local:${model}`;
    this.prefixes = prefixesFor(model);
  }

  embedDocuments(texts: readonly string[]): Promise<Embedding> {
    return this.embed(texts.map((t) => this.prefixes.document + t));
  }

  embedQuery(text: string): Promise<Embedding> {
    return this.embed([this.prefixes.query + text]);
  }

  private async embed(inputs: readonly string[]): Promise<Embedding> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < inputs.length; i += BATCH) {
      const batch = inputs.slice(i, i + BATCH);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, input: batch, truncate: false }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        throw new EmbeddingUnavailableError(
          `Local Ollama is not reachable at ${this.baseUrl}. Start it with "ollama serve" (and "ollama pull ${this.model}").`,
        );
      }
      if (res.status === 404) {
        throw new EmbeddingUnavailableError(
          `Embedding model ${this.model} is not installed: run "ollama pull ${this.model}".`,
        );
      }
      if (!res.ok) {
        throw new EmbeddingUnavailableError(
          `Local embedding failed (HTTP ${String(res.status)}): ${(await res.text()).slice(0, 200)}`,
        );
      }
      const body = (await res.json()) as { embeddings?: unknown; prompt_eval_count?: unknown };
      const embeddings = Array.isArray(body.embeddings) ? (body.embeddings as number[][]) : [];
      if (embeddings.length !== batch.length) {
        throw new EmbeddingUnavailableError(
          `Expected ${String(batch.length)} embeddings, got ${String(embeddings.length)}`,
        );
      }
      vectors.push(...embeddings.map(normalize));
      tokens += typeof body.prompt_eval_count === 'number' ? body.prompt_eval_count : 0;
    }
    const dim = vectors[0]?.length ?? 0;
    if (vectors.some((v) => v.length !== dim))
      throw new EmbeddingUnavailableError('Embeddings of different dimensions in one response');
    return { vectors, tokens, model: this.model, dim };
  }
}
