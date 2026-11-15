import type { SpeakersRepository } from '../repositories/speakers.repository.js';
import { chunkDocument } from './chunking.js';
import { CorpusError, loadCorpus } from './corpus.js';
import type { Embedder } from './embedder.js';
import type { Chunk, VectorStore } from './vector-store.js';

export interface IngestResult {
  documents: number;
  chunks: number;
  /** Tokens the embedder processed (prompt_eval_count). */
  tokens: number;
  embedder: string;
  model: string;
  dim: number;
}

/**
 * Corpus root -> chunks -> local embeddings -> every given store (the same vectors, so an eval
 * compares stores, not models). Writes CHUNKS ONLY: speakers are looked up by handle (read-only) to
 * stamp `speakerId` on their chunks; no speaker, event or organisation is ever created or changed.
 */
export async function ingestCorpus(
  root: string,
  deps: { embedder: Embedder; stores: readonly VectorStore[]; speakers: SpeakersRepository },
): Promise<IngestResult & { chunkList: Chunk[] }> {
  const { documents } = await loadCorpus(root);

  const handles = [...new Set(documents.flatMap((d) => (d.speaker ? [d.speaker] : [])))];
  const resolved = new Map<string, string>();
  const unknown: string[] = [];
  for (const h of handles) {
    const s = await deps.speakers.findByHandle(h);
    if (s) resolved.set(h, s._id);
    else unknown.push(h);
  }
  if (unknown.length > 0) {
    throw new CorpusError(
      unknown.map(
        (h) => `speaker "${h}" is not in the database: run "npm run seed-speakers" first`,
      ),
    );
  }

  const pieces = documents.flatMap((doc) => chunkDocument(doc).map((c) => ({ doc, c })));
  const embedding = await deps.embedder.embedDocuments(pieces.map((p) => p.c.text));
  const chunks: Chunk[] = pieces.map(({ doc, c }, i) => {
    const speakerId = doc.speaker ? resolved.get(doc.speaker) : undefined;
    return {
      id: c.id,
      documentId: c.documentId,
      index: c.index,
      heading: c.heading,
      text: c.text,
      kind: doc.kind,
      classification: doc.classification,
      date: doc.date,
      ...(doc.sourceUrl ? { sourceUrl: doc.sourceUrl } : {}),
      ...(doc.eventId ? { eventId: doc.eventId } : {}),
      ...(doc.organisationId ? { organisationId: doc.organisationId } : {}),
      ...(doc.speaker && speakerId ? { speakerHandle: doc.speaker, speakerId } : {}),
      embedder: deps.embedder.ref,
      model: embedding.model,
      dim: embedding.dim,
      vector: embedding.vectors[i] ?? [],
    };
  });
  for (const store of deps.stores) await store.upsert(chunks);
  return {
    documents: documents.length,
    chunks: chunks.length,
    tokens: embedding.tokens,
    embedder: deps.embedder.ref,
    model: embedding.model,
    dim: embedding.dim,
    chunkList: chunks,
  };
}
