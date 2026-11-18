import { readFileSync } from 'node:fs';
import type { gmail_v1 } from '@googleapis/gmail';

interface FixtureMessage {
  id: string;
  threadId: string;
  labels: string[];
  receivedAt: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  body: string;
  attachments: { filename: string; mimeType: string; sizeBytes: number }[];
}
interface Fixture {
  labels: { id: string; name: string }[];
  messages: FixtureMessage[];
}

export interface ApiCalls {
  list: { labelIds: string[]; q?: string }[];
  get: { id: string; format: string; metadataHeaders?: string[] }[];
  threads: { id: string; format: string }[];
  history: string[];
}

/**
 * A stub of the Gmail API itself (not of our transport): the same fixture mailbox, answered in Gmail's
 * own shapes (header arrays, base64url bodies, internalDate in milliseconds), so the REAL GoogleGmailClient
 * and the real service can run a whole poll over it, and a test can count requests by the format they asked for.
 */
export class FakeGmailApi {
  readonly calls: ApiCalls = { list: [], get: [], threads: [], history: [] };
  private readonly fixture: Fixture;

  constructor(path = 'test/fixtures/gmail/mailbox.json') {
    this.fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  }

  /** Cast for the adapter: only the methods the adapter is allowed to use exist. */
  asGmail(): gmail_v1.Gmail {
    const f = this.fixture;
    const byId = (id: string): FixtureMessage => {
      const m = f.messages.find((x) => x.id === id);
      if (!m) throw new Error(`no message ${id}`);
      return m;
    };
    const headerList = (m: FixtureMessage, only?: string[]) =>
      [
        { name: 'From', value: m.from },
        { name: 'To', value: m.to },
        { name: 'Subject', value: m.subject },
        { name: 'Message-ID', value: m.messageId },
        { name: 'X-Private-Thing', value: 'not requested' },
      ].filter((h) => !only || only.map((o) => o.toLowerCase()).includes(h.name.toLowerCase()));
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    const api = {
      users: {
        labels: { list: () => Promise.resolve({ data: { labels: f.labels } }) },
        getProfile: () => Promise.resolve({ data: { historyId: '1000' } }),
        history: {
          list: (p: { startHistoryId: string }) => {
            this.calls.history.push(p.startHistoryId);
            return Promise.resolve({ data: { history: [], historyId: '1000' } });
          },
        },
        messages: {
          list: (p: { labelIds: string[]; q?: string }) => {
            this.calls.list.push({ labelIds: p.labelIds, ...(p.q ? { q: p.q } : {}) });
            const ids = f.messages
              .filter((m) => p.labelIds.every((l) => m.labels.includes(l)))
              .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
            return Promise.resolve({
              data: { messages: ids.map((m) => ({ id: m.id, threadId: m.threadId })) },
            });
          },
          get: (p: { id: string; format: string; metadataHeaders?: string[] }) => {
            this.calls.get.push({
              id: p.id,
              format: p.format,
              ...(p.metadataHeaders ? { metadataHeaders: p.metadataHeaders } : {}),
            });
            const m = byId(p.id);
            const base = {
              id: m.id,
              threadId: m.threadId,
              labelIds: m.labels,
              internalDate: String(Date.parse(m.receivedAt)),
            };
            if (p.format === 'full') {
              return Promise.resolve({
                data: {
                  ...base,
                  payload: {
                    headers: headerList(m),
                    mimeType: 'multipart/mixed',
                    parts: [
                      { mimeType: 'text/plain', body: { data: b64(m.body) } },
                      ...m.attachments.map((a) => ({
                        mimeType: a.mimeType,
                        filename: a.filename,
                        body: { attachmentId: 'x', size: a.sizeBytes },
                      })),
                    ],
                  },
                },
              });
            }
            // metadata: headers only. A real API may add a snippet; this one does, to prove it is not kept.
            return Promise.resolve({
              data: {
                ...base,
                snippet: `SNIPPET-OF-${m.id}`,
                payload: { headers: headerList(m, p.metadataHeaders) },
              },
            });
          },
        },
        threads: {
          get: (p: { id: string; format: string }) => {
            this.calls.threads.push({ id: p.id, format: p.format });
            return Promise.resolve({
              data: {
                id: p.id,
                messages: f.messages
                  .filter((m) => m.threadId === p.id)
                  .map((m) => ({ id: m.id, labelIds: m.labels })),
              },
            });
          },
        },
      },
    };
    return api as unknown as gmail_v1.Gmail;
  }
}
