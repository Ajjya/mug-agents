import { type gmail_v1, gmail as createGmail } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import {
  type GmailAttachmentInfo,
  type GmailClient,
  type GmailFullMessage,
  type GmailHeaders,
  type GmailMetadata,
  type GmailThreadRefs,
  HistoryExpiredError,
  type HistoryPage,
  type HistoryRecord,
  type ListQuery,
  type MessageRef,
} from './gmail.transport.js';
import type { GmailCredentials } from './inbox.config.js';

/**
 * The real Gmail adapter, over `@googleapis/gmail`. READ-ONLY by construction: it calls labels.list,
 * messages.list, messages.get, threads.get, history.list and getProfile, and nothing else (a source
 * scan fails on any Gmail write call). The OAuth client holds only the refresh token and asks for no
 * scope beyond what that token was granted (gmail.readonly, by `inbox auth`).
 *
 * The mapping is tested against a stubbed API object (test/unit/inbox-gmail-client.test.ts); nothing in
 * the test suite touches Gmail.
 */

const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID'];
/** A decoded body is capped so one enormous message cannot become an enormous document. */
const MAX_BODY_CHARS = 1_000_000;

const isoOf = (internalDate: string | null | undefined): string => {
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString();
};

function headersOf(part: gmail_v1.Schema$MessagePart | undefined): GmailHeaders {
  const get = (name: string): string | undefined =>
    part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
  const out: GmailHeaders = {};
  const from = get('From');
  const to = get('To');
  const subject = get('Subject');
  const date = get('Date');
  const messageId = get('Message-ID');
  if (from) out.from = from;
  if (to) out.to = to;
  if (subject) out.subject = subject;
  if (date) out.date = date;
  if (messageId) out.messageId = messageId;
  return out;
}

const decode = (data: string | null | undefined): string =>
  data ? Buffer.from(data, 'base64url').toString('utf8') : '';

const stripHtml = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

interface Walked {
  plain: string[];
  html: string[];
  attachments: GmailAttachmentInfo[];
}

/** Walks the MIME tree: text parts are decoded, attachments are LISTED (name, type, size) and never opened. */
function walk(part: gmail_v1.Schema$MessagePart | undefined, acc: Walked): Walked {
  if (!part) return acc;
  if (part.filename) {
    acc.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      sizeBytes: part.body?.size ?? 0,
    });
  } else if (part.mimeType === 'text/plain') acc.plain.push(decode(part.body?.data));
  else if (part.mimeType === 'text/html') acc.html.push(decode(part.body?.data));
  for (const child of part.parts ?? []) walk(child, acc);
  return acc;
}

/** The status Gmail answers a stale history id with. */
const isNotFound = (err: unknown): boolean => {
  const e = err as { status?: number; code?: number | string; response?: { status?: number } };
  return e.status === 404 || e.code === 404 || e.code === '404' || e.response?.status === 404;
};

export class GoogleGmailClient implements GmailClient {
  constructor(private readonly api: gmail_v1.Gmail) {}

  /** Builds the real client from credentials. The only place an OAuth client is constructed for reading. */
  static fromCredentials(creds: GmailCredentials): GoogleGmailClient {
    const auth = new OAuth2Client(creds.clientId, creds.clientSecret);
    auth.setCredentials({ refresh_token: creds.refreshToken });
    return new GoogleGmailClient(createGmail({ version: 'v1', auth }));
  }

  async resolveLabelId(name: string): Promise<string | null> {
    const r = await this.api.users.labels.list({ userId: 'me' });
    const found = r.data.labels?.find((l) => l.name?.toLowerCase() === name.toLowerCase());
    return found?.id ?? null;
  }

  async listMessageRefs(query: ListQuery): Promise<{ refs: MessageRef[]; nextPageToken?: string }> {
    const r = await this.api.users.messages.list({
      userId: 'me',
      labelIds: [query.labelId], // required by the type: there is no unscoped call here
      ...(query.after ? { q: `after:${query.after}` } : {}),
      maxResults: 500,
      includeSpamTrash: false,
      ...(query.pageToken ? { pageToken: query.pageToken } : {}),
    });
    return {
      refs: (r.data.messages ?? []).flatMap((m) =>
        m.id && m.threadId ? [{ id: m.id, threadId: m.threadId }] : [],
      ),
      ...(r.data.nextPageToken ? { nextPageToken: r.data.nextPageToken } : {}),
    };
  }

  /** Headers only (`format: metadata`): no body, and the snippet Gmail may add is not read. */
  async getMetadata(id: string): Promise<GmailMetadata> {
    const r = await this.api.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: METADATA_HEADERS,
    });
    return {
      id: r.data.id ?? id,
      threadId: r.data.threadId ?? '',
      labelIds: r.data.labelIds ?? [],
      receivedAt: isoOf(r.data.internalDate),
      headers: headersOf(r.data.payload),
    };
  }

  async getThreadRefs(threadId: string): Promise<GmailThreadRefs> {
    const r = await this.api.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' });
    return {
      threadId,
      messages: (r.data.messages ?? []).flatMap((m) =>
        m.id ? [{ id: m.id, labelIds: m.labelIds ?? [] }] : [],
      ),
    };
  }

  async getCurrentHistoryId(): Promise<string> {
    const r = await this.api.users.getProfile({ userId: 'me' });
    if (!r.data.historyId) throw new Error('Gmail did not return a history id');
    return r.data.historyId;
  }

  async listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
    try {
      const r = await this.api.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded', 'labelAdded'],
        maxResults: 500,
        ...(pageToken ? { pageToken } : {}),
      });
      const records: HistoryRecord[] = [];
      for (const h of r.data.history ?? []) {
        const messages = [
          ...(h.messagesAdded ?? []).map((x) => x.message),
          ...(h.labelsAdded ?? []).map((x) => x.message),
        ];
        for (const m of messages) {
          if (m?.id && m.threadId) {
            records.push({ messageId: m.id, threadId: m.threadId, labelIds: m.labelIds ?? [] });
          }
        }
      }
      return {
        records,
        historyId: r.data.historyId ?? startHistoryId,
        ...(r.data.nextPageToken ? { nextPageToken: r.data.nextPageToken } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) throw new HistoryExpiredError();
      throw err;
    }
  }

  /** The ONLY body fetch in the adapter (`format: full`), reached only through GmailClient. */
  async getFull(id: string): Promise<GmailFullMessage> {
    const r = await this.api.users.messages.get({ userId: 'me', id, format: 'full' });
    const walked = walk(r.data.payload, { plain: [], html: [], attachments: [] });
    const text =
      walked.plain.length > 0 ? walked.plain.join('\n') : stripHtml(walked.html.join('\n'));
    return {
      id: r.data.id ?? id,
      threadId: r.data.threadId ?? '',
      labelIds: r.data.labelIds ?? [],
      receivedAt: isoOf(r.data.internalDate),
      headers: headersOf(r.data.payload),
      bodyText:
        text.length > MAX_BODY_CHARS
          ? `${text.slice(0, MAX_BODY_CHARS)}\n[... body truncated]`
          : text,
      attachments: walked.attachments,
    };
  }
}

/**
 * Defers building the real client (and demanding credentials) until a Gmail call is actually made, so
 * `inbox candidates`, `inbox admit` and the other database-only commands never need Gmail credentials.
 */
export class LazyGmailClient implements GmailClient {
  private inner: GmailClient | undefined;
  constructor(private readonly build: () => GmailClient) {}
  private c(): GmailClient {
    return (this.inner ??= this.build());
  }
  resolveLabelId(name: string) {
    return this.c().resolveLabelId(name);
  }
  listMessageRefs(query: ListQuery) {
    return this.c().listMessageRefs(query);
  }
  getMetadata(id: string) {
    return this.c().getMetadata(id);
  }
  getThreadRefs(threadId: string) {
    return this.c().getThreadRefs(threadId);
  }
  getCurrentHistoryId() {
    return this.c().getCurrentHistoryId();
  }
  listHistory(startHistoryId: string, pageToken?: string) {
    return this.c().listHistory(startHistoryId, pageToken);
  }
  getFull(id: string) {
    return this.c().getFull(id);
  }
}
