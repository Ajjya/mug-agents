import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SPEC 5.3, enforced by shape. The raw body is stored and may be shown to the organiser, but it reaches
 * exactly one model call (the triage call, which receives the REDACTED text), and NOTHING downstream
 * reads it. Like no-delete.test.ts, this is a source scan: a new caller fails the build.
 *
 *  - `getRawBody` (the only door to the body) is mentioned only inside the inbox module and the inbox CLI;
 *  - the field `bodyText` is mentioned only there and in the domain schema that defines it;
 *  - the candidate path (candidates.ts) contains no body fetch at all;
 *  - nothing outside the inbox module and its CLI imports the inbox modules.
 */

function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

const sources = [...files('src'), ...files('scripts')];
const insideInbox = (f: string): boolean => f.startsWith('src/inbox/') || f === 'scripts/inbox.ts';
const read = (f: string): string => readFileSync(f, 'utf8');

export const RAW_BODY_CALL = /\bgetRawBody\b/;
export const BODY_FIELD = /\bbodyText\b/;
export const BODY_FETCH = /\b(?:getFull|getRawBody|bodyText)\b|format\s*:\s*['"](?:full|raw)['"]/;
export const INBOX_IMPORT = /from\s+['"][^'"]*(?:\/inbox\/|inbox\.schema)[^'"]*['"]/;

describe('no downstream module can reach a raw body', () => {
  it('getRawBody is mentioned only inside the inbox module and the inbox CLI', () => {
    const offenders = sources.filter((f) => !insideInbox(f) && RAW_BODY_CALL.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the bodyText field is mentioned only there and in the domain schema that defines it', () => {
    const offenders = sources.filter(
      (f) => !insideInbox(f) && f !== 'src/domain/inbox.schema.ts' && BODY_FIELD.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('nothing outside the inbox module and its CLI imports an inbox module', () => {
    const offenders = sources.filter((f) => !insideInbox(f) && INBOX_IMPORT.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('the candidate path has no body fetch, no body field and no raw-body access', () => {
    const text = read('src/inbox/candidates.ts');
    // Comments describe the guarantee; strip them so the scan looks at code.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(BODY_FETCH.test(code)).toBe(false);
    expect(code).toContain('GmailMetadataClient');
    expect(code).not.toContain('GmailClient');
  });

  it('the Gmail transport gives the metadata client no way to read a body', () => {
    const text = read('src/inbox/gmail.transport.ts');
    const meta = /export interface GmailMetadataClient \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
    expect(meta).not.toBe('');
    expect(meta).not.toMatch(/getFull|body|raw|snippet/i);
    expect(
      /export interface GmailClient extends GmailMetadataClient \{[\s\S]*?getFull/.test(text),
    ).toBe(true);
  });

  it('listing requires a label id: an unscoped list is not expressible', () => {
    const text = read('src/inbox/gmail.transport.ts');
    expect(/export interface ListQuery \{[\s\S]*?labelId: string;/.test(text)).toBe(true);
    expect(/listMessageRefs\(query: ListQuery\)/.test(text)).toBe(true);
  });

  describe('the matchers themselves', () => {
    it.each([
      ['const raw = await repo.getRawBody(id);', RAW_BODY_CALL, true],
      ['message.bodyText.length', BODY_FIELD, true],
      ['await gmail.getFull(id)', BODY_FETCH, true],
      ["messages.get({ format: 'full' })", BODY_FETCH, true],
      ["messages.get({ format: 'metadata' })", BODY_FETCH, false],
      ['m.bodyRedacted', BODY_FIELD, false],
      ["import { x } from '../inbox/inbox.service.js';", INBOX_IMPORT, true],
      ["import { x } from '../domain/inbox.schema.js';", INBOX_IMPORT, true],
      ["import { x } from '../retrieval/ingest.js';", INBOX_IMPORT, false],
    ])('%s', (source, re, hit) => {
      expect(re.test(source)).toBe(hit);
    });
  });
});
