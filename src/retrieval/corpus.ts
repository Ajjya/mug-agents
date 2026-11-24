import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { SPEAKER_HANDLE_RE } from '../domain/speaker.schema.js';

export const CORPUS_KINDS = ['event', 'post', 'abstract', 'note', 'host_note'] as const;
export type CorpusKind = (typeof CORPUS_KINDS)[number];

export const CLASSIFICATIONS = ['public', 'personal'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const ManifestEntrySchema = z
  .object({
    path: z.string().regex(/^[\w./-]+\.md$/, 'must be a relative path to a .md file'),
    kind: z.enum(CORPUS_KINDS),
    /** Mandatory: decides which searches may ever see this document's chunks. */
    classification: z.enum(CLASSIFICATIONS),
    date: z.iso.date(),
    sourceUrl: z.url().optional(),
    eventId: z.string().min(1).optional(),
    organisationId: z.string().min(1).optional(),
    /** The speaker's stable handle (from the seed file), not a database id. */
    speaker: z.string().regex(SPEAKER_HANDLE_RE).optional(),
  })
  .strict();
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z
  .object({ documents: z.array(ManifestEntrySchema) })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.documents.forEach((d, i) => {
      if (seen.has(d.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['documents', i, 'path'],
          message: `duplicate entry ${d.path}`,
        });
      }
      seen.add(d.path);
    });
  });
export type Manifest = z.infer<typeof ManifestSchema>;

export interface CorpusDocument extends ManifestEntry {
  /** Stable id: the path without `.md`, e.g. `abstracts/sharding-without-tears`. */
  documentId: string;
  text: string;
}

export class CorpusError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`The corpus cannot be trusted:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'CorpusError';
  }
}

export const documentIdOf = (path: string): string => path.replace(/\.md$/, '');

async function markdownFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...(await markdownFiles(root, full)));
    else if (name.endsWith('.md')) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** Top-level files that are corpus metadata, not documents. */
const NOT_DOCUMENTS = new Set(['README.md']);

/**
 * Reads a corpus root. Every .md file must have a manifest entry and every entry its file: a corpus
 * you cannot account for is a corpus you cannot trust a citation from. Fails with every problem listed.
 */
export async function loadCorpus(
  root: string,
): Promise<{ manifest: Manifest; documents: CorpusDocument[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  } catch (err) {
    throw new CorpusError([
      `cannot read ${join(root, 'manifest.json')}: ${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CorpusError(
      parsed.error.issues.map((i) => `manifest ${i.path.join('.')}: ${i.message}`),
    );
  }
  const manifest = parsed.data;
  const files = new Set((await markdownFiles(root)).filter((f) => !NOT_DOCUMENTS.has(f)));
  const listed = new Set(manifest.documents.map((d) => d.path));
  const problems = [
    ...[...files].filter((f) => !listed.has(f)).map((f) => `file ${f} has no manifest entry`),
    ...[...listed].filter((p) => !files.has(p)).map((p) => `manifest entry ${p} has no file`),
  ];
  if (problems.length > 0) throw new CorpusError(problems);

  const documents = await Promise.all(
    manifest.documents.map(async (entry) => ({
      ...entry,
      documentId: documentIdOf(entry.path),
      text: await readFile(join(root, entry.path), 'utf8'),
    })),
  );
  return { manifest, documents };
}
