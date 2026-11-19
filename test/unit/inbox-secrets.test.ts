import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { GmailTransportError, sanitizeTransportError } from '../../src/inbox/gmail.errors.js';
import { ImapGmailClient, type ImapSession } from '../../src/inbox/imap.client.js';

const APP_PASSWORD = 'abcd efgh ijkl mnop';
const COMPACT = 'abcdefghijklmnop';
const USER = 'organiser.real@gmail.invalid';
const SECRETS = [APP_PASSWORD, COMPACT, USER];
const PLAIN_B64 = Buffer.from(`\0${USER}\0${COMPACT}`).toString('base64');

/** An error shaped like what an IMAP library throws on a failed login: it echoes the command. */
function realisticError(): Error {
  const err = new Error(`Command failed: A1 LOGIN "${USER}" "${APP_PASSWORD}"`);
  return Object.assign(err, {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    responseStatus: 'NO',
    responseText: `[AUTHENTICATIONFAILED] Invalid credentials. A1 LOGIN ${USER} ${COMPACT} AUTHENTICATE PLAIN ${PLAIN_B64}`,
    command: `A1 LOGIN "${USER}" "${APP_PASSWORD}"`,
    response: { command: `A1 LOGIN "${USER}" "${APP_PASSWORD}"`, tag: 'A1' },
    cause: Object.assign(new Error(`socket: ${COMPACT}`), { config: { pass: COMPACT } }),
  });
}

/** Everything a developer or a logger could see of an error. */
function everythingAbout(err: unknown): string {
  const e = err as Error;
  return [
    e.message,
    e.stack ?? '',
    inspect(e, { depth: null, showHidden: true }),
    JSON.stringify(e, Object.getOwnPropertyNames(e)),
    JSON.stringify(e),
  ].join('\n');
}

describe('a serialized transport error never carries the app password (spec 4)', () => {
  it('the raw error DOES contain it (the problem is real: IMAP libraries echo the failed LOGIN)', () => {
    const text = everythingAbout(realisticError());
    expect(text).toContain(APP_PASSWORD);
    expect(text).toContain(COMPACT);
    expect(text).toContain(PLAIN_B64);
  });

  it('sanitizeTransportError keeps the operation and a scrubbed message, and nothing a secret could be in', () => {
    const out = sanitizeTransportError('LOGIN', realisticError(), SECRETS);
    expect(out).toBeInstanceOf(GmailTransportError);
    expect(out).toMatchObject({ operation: 'LOGIN', name: 'GmailTransportError' });
    expect(out.message).toContain('LOGIN failed');
    expect(out.message).toContain('AUTHENTICATIONFAILED');
    const text = everythingAbout(out);
    for (const secret of [...SECRETS, PLAIN_B64]) expect(text).not.toContain(secret);
    expect(Object.keys(out).sort()).toEqual(['name', 'operation']); // own properties: no command, no response, no cause
    expect((out as { cause?: unknown }).cause).toBeUndefined();
  });

  it('scrubs credential SHAPES even when the secret list does not name them (a rotated password)', () => {
    const e = new Error(
      `failed A2 LOGIN "someone" "wxyz wxyz wxyz wxyz" and ${PLAIN_B64} and qrst uvwx qrst uvwx`,
    );
    const out = sanitizeTransportError('x', e, []);
    expect(out.message).not.toContain('wxyz');
    expect(out.message).not.toContain(PLAIN_B64);
    expect(out.message).not.toContain('qrst');
  });

  it('an error that is not an Error is still safe', () => {
    expect(sanitizeTransportError('y', `plain ${APP_PASSWORD}`, SECRETS).message).not.toContain(
      COMPACT,
    );
    expect(sanitizeTransportError('y', { weird: COMPACT }, SECRETS).message).not.toContain(COMPACT);
  });
});

describe('ImapGmailClient throws sanitized errors for EVERY call', () => {
  function client(failAt: 'connect' | 'list' | 'lock') {
    const fail = () => Promise.reject(realisticError());
    const session = {
      connect: failAt === 'connect' ? fail : () => Promise.resolve(undefined),
      list: failAt === 'list' ? fail : () => Promise.resolve([{ path: 'mug-agents' }]),
      getMailboxLock: fail,
      mailbox: false,
      search: fail,
      fetch: () => {
        throw realisticError();
      },
      download: fail,
      logout: () => Promise.resolve(undefined),
    } as unknown as ImapSession;
    return new ImapGmailClient(() => session, ['mug-agents'], SECRETS);
  }
  const ref = { id: '1', threadId: '1', folder: 'mug-agents', uid: 1 };
  const calls: [string, 'connect' | 'list' | 'lock', (c: ImapGmailClient) => Promise<unknown>][] = [
    ['LIST: connect fails', 'connect', (c) => c.resolveLabelId('mug-agents')],
    ['LIST: list fails', 'list', (c) => c.resolveLabelId('mug-agents')],
    [
      'UID SEARCH',
      'lock',
      async (c) => {
        await c.resolveLabelId('mug-agents');
        return await c.listMessageRefs({ labelId: 'mug-agents', limit: 10 });
      },
    ],
    [
      'UID FETCH (ENVELOPE)',
      'lock',
      async (c) => {
        await c.resolveLabelId('mug-agents');
        return await c.getMetadata(ref);
      },
    ],
    [
      'UID FETCH (BODYSTRUCTURE, text parts)',
      'lock',
      async (c) => {
        await c.resolveLabelId('mug-agents');
        return await c.getFull(ref);
      },
    ],
  ];
  it.each(calls)('%s', async (_name, failAt, call) => {
    const err = await call(client(failAt)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailTransportError);
    const text = everythingAbout(err);
    for (const secret of [...SECRETS, PLAIN_B64]) expect(text).not.toContain(secret);
  });

  it('close() never throws, even when logout fails with the same error', async () => {
    const session = {
      connect: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      logout: vi.fn().mockRejectedValue(realisticError()),
    } as unknown as ImapSession;
    const c = new ImapGmailClient(() => session, ['mug-agents'], SECRETS);
    await c.resolveLabelId('mug-agents');
    await expect(c.close()).resolves.toBeUndefined();
  });
});
