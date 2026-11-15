import { createHash } from 'node:crypto';
import type { Embedder, Embedding } from '../../src/retrieval/embedder.js';
import { normalize } from '../../src/retrieval/embedder.js';
import { terms } from '../../src/retrieval/scoring.js';

/**
 * Deterministic, offline embedder for tests: a hashed bag of words (each term adds weight to one of
 * `dim` buckets), normalised. Texts that share words get a high cosine; unrelated texts a low one.
 * Nothing leaves the process and no Ollama is needed.
 */
export class StubEmbedder implements Embedder {
  readonly ref: string;
  calls = 0;
  constructor(
    readonly model = 'stub-embed',
    private readonly dim = 256,
  ) {
    this.ref = `ollama-local:${model}`;
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const t of terms(text)) {
      const bucket = (createHash('sha1').update(t).digest()[0] ?? 0) % this.dim;
      v[bucket] = (v[bucket] ?? 0) + 1;
    }
    v[this.dim - 1] = (v[this.dim - 1] ?? 0) + 0.01; // never the zero vector
    return normalize(v);
  }

  embedDocuments(texts: readonly string[]): Promise<Embedding> {
    this.calls++;
    return Promise.resolve({
      vectors: texts.map((t) => this.vector(t)),
      tokens: texts.reduce((n, t) => n + terms(t).length, 0),
      model: this.model,
      dim: this.dim,
    });
  }

  embedQuery(text: string): Promise<Embedding> {
    return this.embedDocuments([text]);
  }
}
