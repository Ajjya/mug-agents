import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_CONTEXT_TOKENS,
  MAX_CHUNK_TOKENS,
  chunkDocument,
  estimateTokens,
} from '../../src/retrieval/chunking.js';
import { CorpusError, loadCorpus } from '../../src/retrieval/corpus.js';

async function corpus(files: Record<string, string>, manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'corpus-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return root;
}
const entry = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  kind: 'post',
  classification: 'public',
  date: '2026-03-12',
  ...over,
});

describe('loadCorpus (manifest validation)', () => {
  it('loads the committed sample corpus', async () => {
    const { documents } = await loadCorpus('corpus/sample');
    expect(documents.length).toBeGreaterThanOrEqual(6);
    expect(documents.length).toBeLessThanOrEqual(10);
    expect(documents.some((d) => d.classification === 'personal')).toBe(true);
    expect(documents.find((d) => d.documentId === 'posts/community-update')?.text).toContain(
      'IGNORE ALL PREVIOUS INSTRUCTIONS',
    );
  });

  it('fails on a file that has no manifest entry', async () => {
    const root = await corpus(
      { 'posts/a.md': '# A', 'posts/b.md': '# B' },
      { documents: [entry('posts/a.md')] },
    );
    await expect(loadCorpus(root)).rejects.toThrow(/posts\/b\.md has no manifest entry/);
  });

  it('fails on a manifest entry that has no file', async () => {
    const root = await corpus(
      { 'posts/a.md': '# A' },
      { documents: [entry('posts/a.md'), entry('posts/gone.md')] },
    );
    await expect(loadCorpus(root)).rejects.toThrow(/posts\/gone\.md has no file/);
  });

  it('rejects a bad or missing classification, an unknown kind, an extra key and duplicates', async () => {
    for (const bad of [
      entry('posts/a.md', { classification: 'secret' }),
      { path: 'posts/a.md', kind: 'post', date: '2026-03-12' },
      entry('posts/a.md', { kind: 'tweet' }),
      entry('posts/a.md', { surprise: true }),
    ]) {
      const root = await corpus({ 'posts/a.md': '# A' }, { documents: [bad] });
      await expect(loadCorpus(root)).rejects.toBeInstanceOf(CorpusError);
    }
    const dup = await corpus(
      { 'posts/a.md': '# A' },
      { documents: [entry('posts/a.md'), entry('posts/a.md')] },
    );
    await expect(loadCorpus(dup)).rejects.toThrow(/duplicate entry/);
  });
});

describe('chunkDocument', () => {
  it('keeps a document that fits as ONE chunk, with its title as heading', () => {
    const text = '# Short Abstract\n\nOne paragraph.\n\n## Takeaways\n\nAnother.';
    const chunks = chunkDocument({ documentId: 'abstracts/x', text });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      id: 'abstracts/x#0',
      heading: 'Short Abstract',
      text: text.trim(),
    });
  });

  it('splits an oversized document at headings first, prefixing later sections with the title', () => {
    const section = (n: number) => `## Part ${String(n)}\n\n${'word '.repeat(120)}`;
    const text = `# Big Doc\n\nIntro.\n\n${section(1)}\n\n${section(2)}`;
    const chunks = chunkDocument({ documentId: 'notes/big', text }, 300, 30);
    expect(chunks.map((c) => c.heading)).toEqual(['Big Doc', 'Part 1', 'Part 2']);
    expect(chunks[1]?.text.startsWith('Big Doc: ## Part 1')).toBe(true);
    expect(chunks.map((c) => c.id)).toEqual(['notes/big#0', 'notes/big#1', 'notes/big#2']);
  });

  it('windows only a section that is itself too large, with overlap, never beyond the max', () => {
    const words = Array.from({ length: 600 }, (_, i) => `w${String(i)}`).join(' ');
    const chunks = chunkDocument({ documentId: 'notes/huge', text: `# Huge\n\n${words}` }, 400, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.estimatedTokens).toBeLessThanOrEqual(400);
    const first = chunks[0]?.text.split(' ') ?? [];
    const second = chunks[1]?.text.split(' ') ?? [];
    expect(second.slice(0, 3).every((w) => first.includes(w))).toBe(true); // overlap
  });

  it('the maximum chunk size sits well below the context the installed model really has', () => {
    expect(MAX_CHUNK_TOKENS).toBeLessThan(EMBEDDING_CONTEXT_TOKENS);
    expect(EMBEDDING_CONTEXT_TOKENS).toBe(2048); // measured, not the 8192 the model card claims
    // The estimate over-counts: 'replication ' was measured at 1 token per word.
    expect(estimateTokens('replication '.repeat(100))).toBeGreaterThanOrEqual(100);
  });

  it('every sample document becomes chunks under the limit', async () => {
    const { documents } = await loadCorpus('corpus/sample');
    for (const d of documents) {
      for (const c of chunkDocument(d))
        expect(c.estimatedTokens).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
  });
});
