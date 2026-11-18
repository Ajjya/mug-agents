import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../../src/config/env.schema.js';
import {
  GMAIL_SCOPES,
  requireGmailCredentials,
  resolveInboxConfig,
} from '../../src/inbox/inbox.config.js';

const base = { MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB: 'x_dev' };
const env = (over: Record<string, string> = {}) => parseEnv({ ...base, ...over });
const problems = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return [...e.problems];
    throw e;
  }
  return [];
};

describe('the two labels: required, distinct, no default (spec 1.4)', () => {
  it('an unset label fails, and says which', () => {
    expect(problems(() => resolveInboxConfig(env()))).toEqual([
      'GMAIL_LABEL: required, no default (the label that admits mail)',
      'GMAIL_CANDIDATE_LABEL: required, no default (the metadata-only label)',
    ]);
    expect(problems(() => resolveInboxConfig(env({ GMAIL_LABEL: 'mug-agents' })))).toHaveLength(1);
    expect(
      problems(() => resolveInboxConfig(env({ GMAIL_CANDIDATE_LABEL: 'mug-maybe' }))),
    ).toHaveLength(1);
  });

  it('a blank label is not a label', () => {
    expect(() => env({ GMAIL_LABEL: '   ' })).toThrow(/GMAIL_LABEL/);
  });

  it('the two being equal fails, ignoring case', () => {
    const p = problems(() =>
      resolveInboxConfig(env({ GMAIL_LABEL: 'mug-agents', GMAIL_CANDIDATE_LABEL: 'MUG-Agents' })),
    );
    expect(p).toEqual([expect.stringContaining('must differ')]);
  });

  it('valid labels resolve; triage starts on gpt-oss:20b, rung 1 of the default ladder', () => {
    const c = resolveInboxConfig(
      env({ GMAIL_LABEL: 'mug-agents', GMAIL_CANDIDATE_LABEL: 'mug-maybe' }),
    );
    expect(c).toMatchObject({
      label: 'mug-agents',
      candidateLabel: 'mug-maybe',
      triageStartRung: 1,
      triageMaxChars: 6000,
      sweepMaxPages: 20,
    });
  });

  it('a start model that is not in the ladder fails at boot', () => {
    const p = problems(() =>
      resolveInboxConfig(
        env({
          GMAIL_LABEL: 'a',
          GMAIL_CANDIDATE_LABEL: 'b',
          TRIAGE_START_MODEL: 'ollama:nonesuch',
        }),
      ),
    );
    expect(p[0]).toMatch(/not in LLM_MODEL_LADDER/);
  });

  it('the global schema alone does not require them (other commands still boot)', () => {
    expect(env().GMAIL_LABEL).toBeUndefined();
  });
});

describe('credentials never appear in an error', () => {
  it('a bad config does not echo a secret that is set', () => {
    const secret = 'ya29.not-a-real-token-1234567890';
    try {
      env({ GMAIL_REFRESH_TOKEN: secret, GMAIL_CLIENT_SECRET: secret, PORT: 'abc' });
      expect.unreachable();
    } catch (e) {
      const text = JSON.stringify(e, Object.getOwnPropertyNames(e));
      expect(text).not.toContain(secret);
      expect(text).toContain('PORT');
    }
  });

  it('missing credentials are listed by NAME', () => {
    const p = problems(() => requireGmailCredentials(env({ GMAIL_CLIENT_ID: 'id-value' })));
    expect(p.map((x) => x.split(':')[0])).toEqual(['GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']);
    expect(p.join()).not.toContain('id-value');
  });
});

describe('only the read-only scope exists (spec 4, acceptance)', () => {
  it('GMAIL_SCOPES is gmail.readonly and nothing else', () => {
    expect([...GMAIL_SCOPES]).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  });

  function* files(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* files(path);
      else if (/\.(ts|mjs|json|example)$/.test(path)) yield path;
    }
  }

  // Code and config only: src, scripts, package.json, .env.example. (Docs may name the M4b scope.)
  const WIDER =
    /gmail\.(compose|send|modify|insert|settings\.\w+|labels)\b|mail\.google\.com\/?['"`]|gmail\.metadata/;

  it('no send, compose, modify or other wider scope appears in code or config', () => {
    const targets = [...files('src'), ...files('scripts'), 'package.json', '.env.example'];
    const offenders = targets.filter((f) => WIDER.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['https://www.googleapis.com/auth/gmail.compose', true],
    ['https://www.googleapis.com/auth/gmail.send', true],
    ['https://www.googleapis.com/auth/gmail.modify', true],
    ["'https://mail.google.com/'", true],
    ['https://www.googleapis.com/auth/gmail.readonly', false],
  ])('the scan matcher: %s', (scope, hit) => {
    expect(WIDER.test(scope)).toBe(hit);
  });

  // Gmail's own write methods, by their API path: users.drafts.*, users.messages.send / insert /
  // import / modify / trash / delete, users.threads.modify / trash / delete, users.labels writes.
  const GMAIL_WRITE_CALL =
    /users\.drafts\b|users\.messages\.(send|insert|import|modify|batchModify|trash|untrash|delete|batchDelete)\b|users\.threads\.(modify|trash|untrash|delete)\b|users\.labels\.(create|update|patch|delete)\b/;

  it('no Gmail write method is called anywhere in src or scripts', () => {
    const offenders = [...files('src'), ...files('scripts')].filter((f) =>
      GMAIL_WRITE_CALL.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    ['gmail.users.messages.send({})', true],
    ['gmail.users.drafts.create({})', true],
    ['gmail.users.threads.modify({})', true],
    ['gmail.users.messages.get({})', false],
    ['gmail.users.messages.list({})', false],
    ['gmail.users.history.list({})', false],
    ['this.messages.insert({})', false], // our own drafts collection
  ])('the write-call matcher: %s', (source, hit) => {
    expect(GMAIL_WRITE_CALL.test(source)).toBe(hit);
  });
});
