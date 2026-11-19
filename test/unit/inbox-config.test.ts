import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../../src/config/env.schema.js';
import { requireImapCredentials, resolveInboxConfig } from '../../src/inbox/inbox.config.js';

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
      sweepPageSize: 200,
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

describe('a label that names a system folder fails at boot', () => {
  it.each(['INBOX', 'inbox', '[Gmail]/All Mail', '[Gmail]/Sent Mail', '[Gmail]'])(
    '%s as GMAIL_LABEL',
    (name) => {
      const p = problems(() =>
        resolveInboxConfig(env({ GMAIL_LABEL: name, GMAIL_CANDIDATE_LABEL: 'mug-maybe' })),
      );
      expect(p).toEqual([expect.stringContaining('never opened')]);
    },
  );
  it('and as the candidate label', () => {
    const p = problems(() =>
      resolveInboxConfig(env({ GMAIL_LABEL: 'mug-agents', GMAIL_CANDIDATE_LABEL: 'INBOX' })),
    );
    expect(p).toEqual([expect.stringContaining('GMAIL_CANDIDATE_LABEL')]);
  });
});

describe('credentials never appear in an error', () => {
  it('a bad config does not echo a secret that is set', () => {
    const secret = 'abcd efgh ijkl mnop';
    try {
      env({ IMAP_APP_PASSWORD: secret, PORT: 'abc' });
      expect.unreachable();
    } catch (e) {
      const text = JSON.stringify(e, Object.getOwnPropertyNames(e));
      expect(text).not.toContain(secret);
      expect(text).toContain('PORT');
    }
  });

  it('missing credentials are listed by NAME', () => {
    const p = problems(() => requireImapCredentials(env({ IMAP_USER: 'user-value' })));
    expect(p.map((x) => x.split(':')[0])).toEqual(['IMAP_APP_PASSWORD']);
    expect(p.join()).not.toContain('user-value');
  });

  it('the host and port default to Gmail', () => {
    const c = requireImapCredentials(
      env({ IMAP_USER: 'u@example.invalid', IMAP_APP_PASSWORD: 'p' }),
    );
    expect(c).toMatchObject({ host: 'imap.gmail.com', port: 993 });
  });
});
