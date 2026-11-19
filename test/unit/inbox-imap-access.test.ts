import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SOURCE SCANS for the access model over IMAP (spec 1, like no-delete.test.ts for deletion):
 *  - nothing in src/ or scripts/ can write to the mailbox: no APPEND, STORE, EXPUNGE, COPY, MOVE, no flag,
 *    label, folder or message change, and no raw command escape hatch;
 *  - the ONE place a folder is opened is the read-only lock inside the client, and INBOX and the
 *    `[Gmail]/...` folders (All Mail above all) are named in exactly one file, the deny-list.
 * Comments are stripped first, so prose that explains the rule cannot trip it or hide a violation.
 */

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** imapflow methods that change a mailbox, and the protocol verbs themselves. */
export const IMAP_WRITE_METHOD =
  /\b(?:append|messageDelete|messageFlagsAdd|messageFlagsSet|messageFlagsRemove|messageCopy|messageMove|setFlagColor|mailboxCreate|mailboxDelete|mailboxRename|mailboxSubscribe|mailboxUnsubscribe|idle)\s*\(/;
export const IMAP_WRITE_VERB =
  /['"`]\s*(?:UID\s+)?(?:APPEND|STORE|EXPUNGE|COPY|MOVE|DELETE|CREATE|RENAME)\b/i;
/** The raw-command escape hatch of the library. */
export const IMAP_RAW_COMMAND = /\b(?:session|client|imap|s)\.exec\s*\(/;

export const writesToMailbox = (source: string): boolean => {
  const code = stripComments(source);
  return IMAP_WRITE_METHOD.test(code) || IMAP_WRITE_VERB.test(code) || IMAP_RAW_COMMAND.test(code);
};

const targets = [...sourceFiles('src'), ...sourceFiles('scripts')];

describe('no APPEND, STORE or EXPUNGE (or any other write) anywhere in src/ or scripts/', () => {
  it('contains no write method, no write verb, no raw command', () => {
    const offenders = targets.filter((f) => writesToMailbox(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  describe('the matcher itself', () => {
    it.each([
      ['await client.append("Drafts", raw)', true],
      ['await client.messageFlagsAdd(uid, ["\\\\Seen"])', true],
      ['await client.messageDelete(uid)', true],
      ['await client.messageCopy(uid, "mug-agents")', true],
      ['await client.mailboxCreate("x")', true],
      ['await s.exec("STORE", attrs)', true],
      ['const verb = "UID STORE"', true],
      ["const verb = 'EXPUNGE'", true],
      ['await s.fetch(uids, query, { uid: true })', false],
      ['await s.getMailboxLock(path, { readOnly: true })', false],
      ['// we never call client.append or STORE here', false],
      ['/* messageDelete is banned */ const x = 1;', false],
      ['const m = /^references:\\s*(.*)$/im.exec(text);', false], // a RegExp, not the library
    ])('%s', (source, hit) => {
      expect(writesToMailbox(source)).toBe(hit);
    });
  });
});

describe('INBOX and [Gmail]/All Mail are never opened', () => {
  it('a folder is opened by exactly one call, with readOnly: true (EXAMINE), and never through mailboxOpen', () => {
    const calls = targets.flatMap((f) => {
      const code = stripComments(readFileSync(f, 'utf8'));
      return [...code.matchAll(/getMailboxLock\s*\(([^)]*)\)/g)].map((m) => ({ f, args: m[1] }));
    });
    // The ImapSession interface declares it; the client calls it once.
    const real = calls.filter((c) => !/:\s*string/.test(c.args ?? ''));
    expect(real.map((c) => c.f)).toEqual([expect.stringContaining('imap.client.ts')]);
    expect(real[0]?.args).toMatch(/readOnly:\s*true/);
    expect(real[0]?.args).toMatch(/^\s*path\b/); // a variable that passed the guard, never a literal
    const open = targets.filter((f) =>
      /\bmailboxOpen\s*\(|\.select\s*\(/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(open).toEqual([]);
  });

  it('no file names INBOX or a [Gmail] folder as a literal (only the lower-cased deny-list does)', () => {
    // A string literal that IS one of those folder names (the deny-list itself compares lower-cased).
    const FOLDER_LITERAL = /(['"`])(?:INBOX|\[Gmail\](?:\/[^'"`]*)?)\1/;
    const named = targets.filter((f) =>
      FOLDER_LITERAL.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(named).toEqual([]);
    // ...and the deny-list, which compares lower-cased, is where the rule lives.
    expect(readFileSync('src/inbox/folders.ts', 'utf8')).toMatch(/'inbox'[\s\S]*'\[gmail\]/);
  });

  it('the guard runs BEFORE the lock in the client', () => {
    const code = stripComments(readFileSync('src/inbox/imap.client.ts', 'utf8'));
    const guard = code.indexOf('isForbiddenFolder(path)');
    const lock = code.indexOf('await s.getMailboxLock(path');
    expect(guard).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(guard);
  });
});

describe('no trace of OAuth remains in code or config', () => {
  const files = [...targets, 'package.json', '.env.example'];
  const TRACE =
    /googleapis|google-auth-library|OAuth2Client|refresh[_-]?token|client[_-]?secret|GMAIL_CLIENT_(?:ID|SECRET)|GMAIL_REFRESH|gmail\.readonly|console\.cloud\.google/i;
  it('src, scripts, package.json and .env.example', () => {
    const offenders = files.filter((f) => TRACE.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
