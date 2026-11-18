import { readFileSync } from 'node:fs';
import type { gmail_v1 } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';
import { buildAuthUrl, parseCallback } from '../../src/inbox/gmail.auth.js';
import { GoogleGmailClient, LazyGmailClient } from '../../src/inbox/gmail.client.js';
import { HistoryExpiredError } from '../../src/inbox/gmail.transport.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** The few Gmail API methods the adapter may call. Anything else is undefined: calling it throws. */
function stub(over: Record<string, unknown> = {}) {
  const calls = {
    list: vi.fn(),
    get: vi.fn(),
    threads: vi.fn(),
    history: vi.fn(),
    labels: vi.fn(),
    profile: vi.fn(),
  };
  const api = {
    users: {
      labels: {
        list: calls.labels.mockResolvedValue({
          data: { labels: [{ id: 'Label_1', name: 'Mug-Agents' }] },
        }),
      },
      messages: {
        list: calls.list.mockResolvedValue({
          data: { messages: [{ id: 'a', threadId: 't' }, { id: 'b' }], nextPageToken: 'next' },
        }),
        get: calls.get,
      },
      threads: {
        get: calls.threads.mockResolvedValue({
          data: { messages: [{ id: 'a', labelIds: ['INBOX'] }, {}] },
        }),
      },
      history: { list: calls.history },
      getProfile: calls.profile.mockResolvedValue({ data: { historyId: '777' } }),
    },
    ...over,
  };
  return { api: api as unknown as gmail_v1.Gmail, calls };
}

describe('GoogleGmailClient: read-only, label-scoped, metadata really is metadata', () => {
  it('resolves a label by name, case-insensitively, and null when it does not exist', async () => {
    const { api } = stub();
    const c = new GoogleGmailClient(api);
    expect(await c.resolveLabelId('mug-agents')).toBe('Label_1');
    expect(await c.resolveLabelId('nonesuch')).toBeNull();
  });

  it('every listing carries the label id, 500 per page, never spam/trash; q only narrows by date', async () => {
    const { api, calls } = stub();
    const c = new GoogleGmailClient(api);
    const r = await c.listMessageRefs({ labelId: 'Label_1', after: '2026/10/01', pageToken: 'p2' });
    expect(calls.list).toHaveBeenCalledWith({
      userId: 'me',
      labelIds: ['Label_1'],
      q: 'after:2026/10/01',
      maxResults: 500,
      includeSpamTrash: false,
      pageToken: 'p2',
    });
    expect(r).toEqual({ refs: [{ id: 'a', threadId: 't' }], nextPageToken: 'next' }); // an entry without a thread is dropped
    await c.listMessageRefs({ labelId: 'Label_2' });
    expect(calls.list.mock.calls[1]?.[0]).toEqual({
      userId: 'me',
      labelIds: ['Label_2'],
      maxResults: 500,
      includeSpamTrash: false,
    });
  });

  it('getMetadata asks for format=metadata with an explicit header list, and keeps no body and no snippet', async () => {
    const { api, calls } = stub();
    // Even if the API returned a snippet and a body on a metadata fetch, none of it may survive.
    calls.get.mockResolvedValue({
      data: {
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX', 'Label_2'],
        internalDate: '1793000000000',
        snippet: 'LEAKED-SNIPPET',
        payload: {
          headers: [
            { name: 'From', value: 'A <a@x.invalid>' },
            { name: 'subject', value: 'Hello' },
            { name: 'Message-ID', value: '<m1@x.invalid>' },
            { name: 'X-Other', value: 'ignored' },
          ],
          body: { data: b64('LEAKED-BODY') },
          parts: [{ mimeType: 'text/plain', body: { data: b64('LEAKED-PART') } }],
        },
      },
    });
    const m = await new GoogleGmailClient(api).getMetadata('m1');
    expect(calls.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'm1',
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'],
    });
    expect(m).toEqual({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'Label_2'],
      receivedAt: new Date(1793000000000).toISOString(),
      headers: { from: 'A <a@x.invalid>', subject: 'Hello', messageId: '<m1@x.invalid>' },
    });
    expect(JSON.stringify(m)).not.toMatch(/LEAKED/);
  });

  it('getFull decodes multipart text (UTF-8, base64url) and LISTS attachments without opening them', async () => {
    const { api, calls } = stub();
    calls.get.mockResolvedValue({
      data: {
        id: 'm2',
        threadId: 't2',
        labelIds: ['Label_1'],
        internalDate: '1793000000000',
        payload: {
          headers: [{ name: 'From', value: 'W <w@x.invalid>' }],
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { data: b64('Olá! Não posso ir. ✓') } },
                { mimeType: 'text/html', body: { data: b64('<p>HTML VERSION</p>') } },
              ],
            },
            {
              mimeType: 'application/pdf',
              filename: 'slides.pdf',
              body: { attachmentId: 'att1', size: 4096 },
            },
            {
              mimeType: 'image/jpeg',
              filename: 'me.jpg',
              body: { attachmentId: 'att2', size: 245000 },
            },
          ],
        },
      },
    });
    const m = await new GoogleGmailClient(api).getFull('m2');
    expect(calls.get).toHaveBeenCalledWith({ userId: 'me', id: 'm2', format: 'full' });
    expect(m.bodyText).toBe('Olá! Não posso ir. ✓'); // the plain part wins; the HTML twin is not appended
    expect(m.attachments).toEqual([
      { filename: 'slides.pdf', mimeType: 'application/pdf', sizeBytes: 4096 },
      { filename: 'me.jpg', mimeType: 'image/jpeg', sizeBytes: 245000 },
    ]);
    // There is no attachments API on the stub: had the adapter tried to open one, this would have thrown.
  });

  it('getFull falls back to stripped HTML when there is no plain part, and caps an enormous body', async () => {
    const { api, calls } = stub();
    calls.get.mockResolvedValue({
      data: {
        id: 'm3',
        threadId: 't',
        labelIds: [],
        internalDate: '1',
        payload: {
          mimeType: 'text/html',
          body: { data: b64('<div>Hello<br>there &amp; <b>you</b></div><style>x{}</style>') },
        },
      },
    });
    expect((await new GoogleGmailClient(api).getFull('m3')).bodyText).toBe('Hello\nthere & you\n');
    calls.get.mockResolvedValue({
      data: {
        id: 'm4',
        payload: { mimeType: 'text/plain', body: { data: b64('x'.repeat(1_200_000)) } },
      },
    });
    const big = await new GoogleGmailClient(api).getFull('m4');
    expect(big.bodyText.length).toBeLessThan(1_000_100);
    expect(big.bodyText.endsWith('[... body truncated]')).toBe(true);
  });

  it('getThreadRefs asks for format=minimal: ids and labels, no content', async () => {
    const { api, calls } = stub();
    const r = await new GoogleGmailClient(api).getThreadRefs('t9');
    expect(calls.threads).toHaveBeenCalledWith({ userId: 'me', id: 't9', format: 'minimal' });
    expect(r).toEqual({ threadId: 't9', messages: [{ id: 'a', labelIds: ['INBOX'] }] });
  });

  it('history: asks for added messages and added labels, maps both, and a 404 is HistoryExpiredError', async () => {
    const { api, calls } = stub();
    calls.history.mockResolvedValue({
      data: {
        historyId: '900',
        nextPageToken: 'h2',
        history: [
          {
            id: '1',
            messagesAdded: [{ message: { id: 'a', threadId: 't', labelIds: ['INBOX'] } }],
          },
          {
            id: '2',
            labelsAdded: [
              {
                message: { id: 'b', threadId: 'u', labelIds: ['INBOX', 'Label_1'] },
                labelIds: ['Label_1'],
              },
            ],
          },
          { id: '3', messagesDeleted: [{ message: { id: 'c', threadId: 'v' } }] },
        ],
      },
    });
    const c = new GoogleGmailClient(api);
    const page = await c.listHistory('500', 'h1');
    expect(calls.history).toHaveBeenCalledWith({
      userId: 'me',
      startHistoryId: '500',
      historyTypes: ['messageAdded', 'labelAdded'],
      maxResults: 500,
      pageToken: 'h1',
    });
    expect(page).toEqual({
      historyId: '900',
      nextPageToken: 'h2',
      records: [
        { messageId: 'a', threadId: 't', labelIds: ['INBOX'] },
        { messageId: 'b', threadId: 'u', labelIds: ['INBOX', 'Label_1'] },
      ],
    });
    for (const e of [
      { code: 404 },
      { status: 404 },
      { response: { status: 404 } },
      { code: '404' },
    ]) {
      calls.history.mockRejectedValueOnce(
        Object.assign(new Error('Requested entity was not found.'), e),
      );
      await expect(c.listHistory('1')).rejects.toBeInstanceOf(HistoryExpiredError);
    }
    calls.history.mockRejectedValueOnce(Object.assign(new Error('rate limit'), { code: 429 }));
    await expect(c.listHistory('1')).rejects.toThrow('rate limit'); // anything but a 404 is not an expiry
  });

  it('getCurrentHistoryId reads the profile', async () => {
    expect(await new GoogleGmailClient(stub().api).getCurrentHistoryId()).toBe('777');
  });

  it('format: full appears exactly once in the adapter: in getFull', () => {
    const src = readFileSync('src/inbox/gmail.client.ts', 'utf8');
    expect(src.match(/format:\s*['"]full['"]/g)).toHaveLength(1);
    expect(src.match(/format:\s*['"]metadata['"]/g)).toHaveLength(1);
    expect(src.match(/format:\s*['"]minimal['"]/g)).toHaveLength(1);
    expect(src).not.toMatch(/attachments\.get|format:\s*['"]raw['"]/);
  });
});

describe('LazyGmailClient: database-only commands never need credentials', () => {
  it('builds nothing until the first Gmail call, then reuses it', async () => {
    const inner = { resolveLabelId: vi.fn().mockResolvedValue('L') } as never;
    const build = vi.fn(() => inner);
    const lazy = new LazyGmailClient(build);
    expect(build).not.toHaveBeenCalled();
    await lazy.resolveLabelId('x');
    await lazy.resolveLabelId('y');
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('the OAuth flow for an installed app', () => {
  const client = new OAuth2Client('client-id', 'client-secret', 'http://127.0.0.1:5555');
  const url = new URL(buildAuthUrl(client, 'CHALLENGE', 'STATE'));

  it('asks for gmail.readonly and nothing else, offline, with PKCE S256 and a state', () => {
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('accepts a redirect only with the right state, and reports an error plainly', () => {
    expect(parseCallback('/?code=abc&state=STATE', 'STATE')).toEqual({ ok: true, code: 'abc' });
    expect(parseCallback('/?code=abc&state=OTHER', 'STATE')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('state'),
    });
    expect(parseCallback('/?error=access_denied&state=STATE', 'STATE')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('access_denied'),
    });
    expect(parseCallback('/?state=STATE', 'STATE')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no authorization code'),
    });
  });
});
