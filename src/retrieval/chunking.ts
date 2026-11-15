import type { CorpusDocument } from './corpus.js';

/**
 * Measured on the installed `nomic-embed-text` tag (Ollama 0.40.15): inputs above 2048 tokens fail with
 * "the input length exceeds the context length", although the model card advertises 8192 (`num_ctx`)
 * and `ollama show` reports a context length of 2048. 2048 is what applies.
 */
export const EMBEDDING_CONTEXT_TOKENS = 2048;

/** Chunks stay well below the context so the embedder never truncates (and it is called with truncate=false). */
export const MAX_CHUNK_TOKENS = 1000;
/** Overlap when an oversized section has to be windowed. */
export const OVERLAP_TOKENS = 120;

/**
 * Conservative token estimate (over-counts English): characters / 3. Exact counts come back from the
 * embedder (`prompt_eval_count`); this only has to keep chunks safely under the limit.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

export interface TextChunk {
  /** `${documentId}#${index}`: the citation id. */
  id: string;
  documentId: string;
  index: number;
  /** The heading the chunk sits under (the document title for a whole document). */
  heading: string;
  text: string;
  estimatedTokens: number;
}

const titleOf = (text: string, fallback: string): string =>
  /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? fallback;

/** Splits at headings (`#`, `##`, `###`), keeping each heading with its section. */
function sections(text: string): { heading: string | null; body: string }[] {
  const out: { heading: string | null; body: string }[] = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  for (const line of text.split('\n')) {
    const h = /^#{1,3}\s+(.+)$/.exec(line);
    if (h) {
      if (current.lines.join('\n').trim() !== '' || current.heading !== null) {
        out.push({ heading: current.heading, body: current.lines.join('\n').trim() });
      }
      current = { heading: h[1]?.trim() ?? null, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  out.push({ heading: current.heading, body: current.lines.join('\n').trim() });
  return out.filter((s) => s.body !== '');
}

/** Windows of whole words with overlap, for a section that is too large on its own. */
function windows(body: string, maxTokens: number, overlapTokens: number): string[] {
  const words = body.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let size = 0;
    while (end < words.length && size + estimateTokens(`${words[end] ?? ''} `) <= maxTokens) {
      size += estimateTokens(`${words[end] ?? ''} `);
      end++;
    }
    if (end === start) end = start + 1; // a single absurdly long "word": take it alone
    out.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;
    let back = 0;
    let overlap = 0;
    while (end - back - 1 > start && overlap < overlapTokens) {
      back++;
      overlap += estimateTokens(`${words[end - back] ?? ''} `);
    }
    start = end - back;
  }
  return out;
}

/**
 * Natural boundaries first: a document that fits is ONE chunk (these documents are short and
 * fixed-size windowing would cut an abstract mid-argument); otherwise one chunk per heading section;
 * only a section that is itself too large is windowed, with overlap. Sections after the first are
 * prefixed with the document title so each chunk still says what it is about.
 */
export function chunkDocument(
  doc: Pick<CorpusDocument, 'documentId' | 'text'>,
  maxTokens: number = MAX_CHUNK_TOKENS,
  overlapTokens: number = OVERLAP_TOKENS,
): TextChunk[] {
  const text = doc.text.trim();
  const title = titleOf(text, doc.documentId);
  const pieces: { heading: string; text: string }[] = [];
  if (estimateTokens(text) <= maxTokens) {
    pieces.push({ heading: title, text });
  } else {
    for (const s of sections(text)) {
      const heading = s.heading ?? title;
      const prefix = s.heading !== null && s.heading !== title ? `${title}: ` : '';
      const body = `${prefix}${s.body}`;
      if (estimateTokens(body) <= maxTokens) pieces.push({ heading, text: body });
      else
        for (const w of windows(body, maxTokens, overlapTokens)) pieces.push({ heading, text: w });
    }
  }
  return pieces.map((p, index) => ({
    id: `${doc.documentId}#${String(index)}`,
    documentId: doc.documentId,
    index,
    heading: p.heading,
    text: p.text,
    estimatedTokens: estimateTokens(p.text),
  }));
}
