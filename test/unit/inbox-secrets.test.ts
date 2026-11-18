import { inspect } from 'node:util';
import type { gmail_v1 } from '@googleapis/gmail';
import { describe, expect, it, vi } from 'vitest';
import { GmailTransportError, sanitizeTransportError } from '../../src/inbox/gmail.errors.js';
import { GoogleGmailClient } from '../../src/inbox/gmail.client.js';
import { HistoryExpiredError } from '../../src/inbox/gmail.transport.js';

const REFRESH = '1//0gSECRETrefreshTOKEN-abcdefghijklmnop';
const CLIENT_SECRET = 'GOCSPX-SECRETclientSECRET-12345678';
const ACCESS = 'ya29.SECRETaccessTOKEN-abcdefghijklmnopqrstuv';
const SECRETS = [REFRESH, CLIENT_SECRET, ACCESS];

/** An error shaped like what the HTTP layer throws: a message, the request config (body and headers) and the response. */
function realisticError(status = 400): Error {
  const config = {
    url: 'https://oauth2.googleapis.com/token',
    method: 'POST',
    data: `grant_type=refresh_token&refresh_token=${REFRESH}&client_secret=${CLIENT_SECRET}&client_id=123.apps.googleusercontent.com`,
    headers: {
      Authorization: `Bearer ${ACCESS}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `refresh_token=${REFRESH}`,
  };
  const err = new Error(
    `invalid_grant: Token has been expired or revoked. (refresh_token=${REFRESH})`,
  );
  return Object.assign(err, {
    status,
    code: String(status),
    config,
    response: {
      status,
      config,
      data: { error: 'invalid_grant' },
      request: { headers: config.headers },
    },
    cause: Object.assign(new Error(`socket: ${REFRESH}`), { config }),
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

describe('a thrown transport error never carries a credential (spec 4)', () => {
  it('the raw error DOES contain the secrets (the problem is real)', () => {
    const text = everythingAbout(realisticError());
    expect(text).toContain(REFRESH);
    expect(text).toContain(CLIENT_SECRET);
    expect(text).toContain(ACCESS);
  });

  it('sanitizeTransportError keeps the operation and the HTTP status and nothing a secret could be in', () => {
    const out = sanitizeTransportError('messages.get', realisticError(401), SECRETS);
    expect(out).toBeInstanceOf(GmailTransportError);
    expect(out).toMatchObject({
      operation: 'messages.get',
      status: 401,
      name: 'GmailTransportError',
    });
    expect(out.message).toContain('messages.get');
    expect(out.message).toContain('invalid_grant');
    const text = everythingAbout(out);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(Object.keys(out).sort()).toEqual(['name', 'operation', 'status']); // own properties: no config, no response, no cause
    expect((out as { cause?: unknown }).cause).toBeUndefined();
  });

  it('scrubs token SHAPES even when the secret list does not name them', () => {
    const e = Object.assign(
      new Error(`failed ${REFRESH} ${ACCESS} ${CLIENT_SECRET} refresh_token=abc123 Bearer abc.def`),
      {},
    );
    const out = sanitizeTransportError('x', e, []);
    for (const secret of SECRETS) expect(out.message).not.toContain(secret);
    expect(out.message).not.toContain('abc123');
    expect(out.message).not.toMatch(/Bearer abc/);
  });

  it('an error that is not an Error, or has no status, is still safe', () => {
    expect(sanitizeTransportError('y', `plain ${REFRESH}`, SECRETS).message).not.toContain(REFRESH);
    expect(sanitizeTransportError('y', { weird: REFRESH }, SECRETS).message).not.toContain(REFRESH);
    expect(sanitizeTransportError('y', undefined, SECRETS).status).toBeUndefined();
  });
});

describe('GoogleGmailClient throws sanitized errors for EVERY call', () => {
  function client() {
    const fail = vi.fn().mockRejectedValue(realisticError(500));
    const api = {
      users: {
        labels: { list: fail },
        messages: { list: fail, get: fail },
        threads: { get: fail },
        history: { list: fail },
        getProfile: fail,
      },
    } as unknown as gmail_v1.Gmail;
    return new GoogleGmailClient(api, SECRETS);
  }
  const calls: [string, (c: GoogleGmailClient) => Promise<unknown>][] = [
    ['labels.list', (c) => c.resolveLabelId('x')],
    ['messages.list', (c) => c.listMessageRefs({ labelId: 'L' })],
    ['messages.get (metadata)', (c) => c.getMetadata('a')],
    ['messages.get (full)', (c) => c.getFull('a')],
    ['threads.get', (c) => c.getThreadRefs('t')],
    ['getProfile', (c) => c.getCurrentHistoryId()],
    ['history.list', (c) => c.listHistory('1')],
  ];
  it.each(calls)('%s', async (_name, call) => {
    const err = await call(client()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailTransportError);
    const text = everythingAbout(err);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(err).toMatchObject({ status: 500 });
  });

  it('a 404 from history is STILL a HistoryExpiredError, not a transport error', async () => {
    const api = {
      users: { history: { list: vi.fn().mockRejectedValue(realisticError(404)) } },
    } as unknown as gmail_v1.Gmail;
    await expect(new GoogleGmailClient(api, SECRETS).listHistory('1')).rejects.toBeInstanceOf(
      HistoryExpiredError,
    );
  });
});
