import { ImapFlow } from 'imapflow';
import { sanitizeTransportError } from './gmail.errors.js';
import { isForbiddenFolder } from './folders.js';
import type {
  GmailAttachmentInfo,
  GmailClient,
  GmailFullMessage,
  GmailHeaders,
  GmailMetadata,
  ListPage,
  ListQuery,
  MessageRef,
} from './gmail.transport.js';
import type { ImapCredentials } from './inbox.config.js';

/**
 * The real mail adapter: Gmail over IMAP with an app password, via `imapflow`. READ-ONLY by construction:
 *
 *  - a folder is opened ONLY through {@link ImapGmailClient.withFolder}, with `readOnly: true` (EXAMINE,
 *    never SELECT), and only if its LIST path is one of the labels this client was built for;
 *  - INBOX and every `[Gmail]/...` folder (All Mail included) are refused outright;
 *  - nothing here appends, stores, copies, moves, deletes or expunges (a source scan fails on any of those);
 *  - a candidate fetch asks for the ENVELOPE (plus Gmail's ids and labels) and nothing else; the body is
 *    reachable only through `getFull`, and even that downloads only the text parts, never an attachment.
 *
 * The mapping is tested against a stubbed session (test/unit/inbox-imap-client.test.ts); nothing in the
 * test suite touches Gmail.
 */

/** What this client uses of an IMAP connection (the real one is `ImapFlow`). */
export interface ImapSession {
  connect(): Promise<unknown>;
  list(): Promise<{ path: string }[]>;
  getMailboxLock(path: string, options: { readOnly: true }): Promise<{ release(): void }>;
  readonly mailbox: false | { uidValidity: bigint | number | string };
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
  fetch(
    range: string | number[],
    query: Record<string, unknown>,
    options: { uid: true },
  ): AsyncIterable<FetchedMessage>;
  download(
    range: string,
    part: string,
    options: { uid: true },
  ): Promise<{ content?: AsyncIterable<Buffer | string> }>;
  logout(): Promise<unknown>;
}

interface EnvelopeAddress {
  name?: string | undefined;
  address?: string | undefined;
}

export interface FetchedMessage {
  uid: number;
  emailId?: string;
  threadId?: string;
  labels?: Set<string>;
  internalDate?: Date | string;
  envelope?: {
    subject?: string;
    messageId?: string;
    inReplyTo?: string;
    date?: Date | string;
    from?: EnvelopeAddress[];
    to?: EnvelopeAddress[];
    cc?: EnvelopeAddress[];
    replyTo?: EnvelopeAddress[];
  };
  bodyStructure?: BodyNode;
  headers?: Buffer;
}

interface BodyNode {
  type?: string;
  part?: string;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: BodyNode[];
}

/** An ENVELOPE address list as the header text the rest of the code parses. */
function formatAddresses(list: EnvelopeAddress[] | undefined): string | undefined {
  const parts = (list ?? []).flatMap((a) => {
    if (!a.address) return [];
    const name = a.name?.replace(/["\\<>]/g, '').trim();
    return [name ? `"${name}" <${a.address}>` : a.address];
  });
  return parts.length > 0 ? parts.join(', ') : undefined;
}

const isoOf = (d: Date | string | undefined): string => {
  const t = d === undefined ? Number.NaN : new Date(d).getTime();
  return new Date(Number.isFinite(t) ? t : 0).toISOString();
};

/** Gmail system labels, spelled the way the rest of the code reads them. */
function labelName(raw: string): string {
  const key = raw.replace(/^\\+/, '').toLowerCase();
  if (raw.startsWith('\\') && key === 'sent') return 'SENT';
  if (raw.startsWith('\\') && key === 'draft') return 'DRAFT';
  return raw;
}

function headersOf(m: FetchedMessage): GmailHeaders {
  const e = m.envelope;
  const out: GmailHeaders = {};
  const from = formatAddresses(e?.from);
  const to = formatAddresses(e?.to);
  const cc = formatAddresses(e?.cc);
  const replyTo = formatAddresses(e?.replyTo);
  if (from) out.from = from;
  if (to) out.to = to;
  if (cc) out.cc = cc;
  if (replyTo) out.replyTo = replyTo;
  if (e?.subject) out.subject = e.subject;
  if (e?.date) out.date = isoOf(e.date);
  if (e?.messageId) out.messageId = e.messageId;
  if (e?.inReplyTo) out.inReplyTo = e.inReplyTo;
  return out;
}

/** `References: <a> <b>` out of the raw header block fetched alongside the body. */
function referencesOf(raw: Buffer | undefined): string | undefined {
  if (!raw) return undefined;
  const unfolded = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const line = /^references:\s*(.*)$/im.exec(unfolded);
  return line?.[1]?.trim() || undefined;
}

interface Walked {
  textParts: { part: string; type: 'plain' | 'html' }[];
  attachments: GmailAttachmentInfo[];
}

/** Walks BODYSTRUCTURE: text parts are listed to be downloaded, attachments are LISTED and never opened. */
function walk(node: BodyNode, acc: Walked, isRoot: boolean): Walked {
  const type = (node.type ?? '').toLowerCase();
  if (node.childNodes && node.childNodes.length > 0) {
    for (const c of node.childNodes) walk(c, acc, false);
    return acc;
  }
  const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name'];
  if (node.disposition?.toLowerCase() === 'attachment' || (filename && !type.startsWith('text/'))) {
    acc.attachments.push({
      filename: filename ?? 'unnamed',
      mimeType: type || 'application/octet-stream',
      sizeBytes: node.size ?? 0,
    });
  } else if (type === 'text/plain' || type === 'text/html') {
    acc.textParts.push({
      part: node.part ?? (isRoot ? '1' : ''),
      type: type === 'text/plain' ? 'plain' : 'html',
    });
  }
  return acc;
}

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

/** A decoded body is capped so one enormous message cannot become an enormous document. */
const MAX_BODY_CHARS = 1_000_000;
const ENVELOPE_QUERY = {
  uid: true,
  envelope: true,
  emailId: true,
  threadId: true,
  labels: true,
  internalDate: true,
} as const;

export class ImapGmailClient implements GmailClient {
  private session: ImapSession | undefined;
  /** LIST paths of the labels this client may open: filled by resolveLabelId, nothing else. */
  private readonly opened = new Set<string>();

  /**
   * `allowedLabels` are the configured label names: the only folders this client will ever resolve.
   * `secrets` are the credential values it was built with, scrubbed from anything a failed call throws.
   */
  constructor(
    private readonly connect: () => ImapSession,
    private readonly allowedLabels: readonly string[],
    private readonly secrets: readonly string[] = [],
  ) {}

  static fromCredentials(
    creds: ImapCredentials,
    allowedLabels: readonly string[],
  ): ImapGmailClient {
    return new ImapGmailClient(
      () =>
        new ImapFlow({
          host: creds.host,
          port: creds.port,
          secure: true,
          auth: { user: creds.user, pass: creds.appPassword },
          logger: false, // the protocol log carries the LOGIN line
        }) as unknown as ImapSession,
      allowedLabels,
      // both spellings of an app password: Google shows it in groups of four
      [creds.appPassword, creds.appPassword.replaceAll(/\s+/g, ''), creds.user],
    );
  }

  private async guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw sanitizeTransportError(operation, err, this.secrets);
    }
  }

  private async ready(): Promise<ImapSession> {
    if (!this.session) {
      const s = this.connect();
      await s.connect();
      this.session = s;
    }
    return this.session;
  }

  /** The ONLY place a folder is opened: read-only (EXAMINE), and only a resolved label folder. */
  private async withFolder<T>(path: string, run: (s: ImapSession) => Promise<T>): Promise<T> {
    if (isForbiddenFolder(path) || !this.opened.has(path)) {
      throw new Error(`refusing to open "${path}": not one of the configured label folders`);
    }
    const s = await this.ready();
    const lock = await s.getMailboxLock(path, { readOnly: true });
    try {
      return await run(s);
    } finally {
      lock.release();
    }
  }

  async resolveLabelId(name: string): Promise<string | null> {
    return await this.guard('LIST', async () => {
      if (!this.allowedLabels.some((l) => l.toLowerCase() === name.toLowerCase())) {
        throw new Error(`"${name}" is not a configured label`);
      }
      const s = await this.ready();
      const found = (await s.list()).find((f) => f.path.toLowerCase() === name.toLowerCase());
      if (!found) return null;
      if (isForbiddenFolder(found.path)) {
        throw new Error(`"${found.path}" is a system folder, not a label`);
      }
      this.opened.add(found.path);
      return found.path;
    });
  }

  async listMessageRefs(query: ListQuery): Promise<ListPage> {
    return await this.guard('UID SEARCH', async () =>
      this.withFolder(query.labelId, async (s) => {
        const uidValidity = String(s.mailbox ? s.mailbox.uidValidity : '');
        const after = query.afterUid ?? 0;
        // `n:*` always includes the highest UID even when it is below n: filter it out.
        const found = await s.search(
          {
            uid: `${String(after + 1)}:*`,
            ...(query.since ? { since: new Date(query.since) } : {}),
          },
          { uid: true },
        );
        const uids = (found || []).filter((u) => u > after).sort((a, b) => a - b);
        const page = uids.slice(0, query.limit);
        const refs: MessageRef[] = [];
        if (page.length > 0) {
          for await (const m of s.fetch(
            page,
            { uid: true, emailId: true, threadId: true },
            { uid: true },
          )) {
            if (m.emailId && m.threadId)
              refs.push({ id: m.emailId, threadId: m.threadId, folder: query.labelId, uid: m.uid });
          }
        }
        refs.sort((a, b) => a.uid - b.uid);
        return { refs, uidValidity, hasMore: uids.length > page.length };
      }),
    );
  }

  /** ENVELOPE only: no body part, no source, no download. */
  async getMetadata(ref: MessageRef): Promise<GmailMetadata> {
    return await this.guard('UID FETCH (ENVELOPE)', async () =>
      this.withFolder(ref.folder, async (s) => {
        const m = await this.fetchOne(s, ref, ENVELOPE_QUERY);
        return this.toMetadata(m, ref);
      }),
    );
  }

  /** The ONLY body read in the adapter, reached only through GmailClient. Text parts only. */
  async getFull(ref: MessageRef): Promise<GmailFullMessage> {
    return await this.guard('UID FETCH (BODYSTRUCTURE, text parts)', async () =>
      this.withFolder(ref.folder, async (s) => {
        const m = await this.fetchOne(s, ref, {
          ...ENVELOPE_QUERY,
          bodyStructure: true,
          headers: ['references'],
        });
        const walked = m.bodyStructure
          ? walk(m.bodyStructure, { textParts: [], attachments: [] }, true)
          : { textParts: [], attachments: [] };
        const plain: string[] = [];
        const html: string[] = [];
        for (const p of walked.textParts) {
          if (!p.part) continue;
          const d = await s.download(String(ref.uid), p.part, { uid: true });
          let text = '';
          if (d.content) for await (const chunk of d.content) text += chunk.toString();
          (p.type === 'plain' ? plain : html).push(text);
        }
        const text = plain.length > 0 ? plain.join('\n') : stripHtml(html.join('\n'));
        const meta = this.toMetadata(m, ref);
        const references = referencesOf(m.headers);
        return {
          ...meta,
          headers: { ...meta.headers, ...(references ? { references } : {}) },
          bodyText:
            text.length > MAX_BODY_CHARS
              ? `${text.slice(0, MAX_BODY_CHARS)}\n[... body truncated]`
              : text,
          attachments: walked.attachments,
        };
      }),
    );
  }

  private async fetchOne(
    s: ImapSession,
    ref: MessageRef,
    query: Record<string, unknown>,
  ): Promise<FetchedMessage> {
    for await (const m of s.fetch([ref.uid], query, { uid: true })) {
      // A UID is only meaningful within one UIDVALIDITY: if the folder was recreated since it was listed,
      // the UID may now be a different message. The Gmail id is the proof it is the one that was listed.
      if (m.uid === ref.uid && m.emailId === ref.id) return m;
      throw new Error(
        `UID ${String(ref.uid)} no longer holds the listed message (folder recreated?)`,
      );
    }
    throw new Error(`UID ${String(ref.uid)} is gone from "${ref.folder}"`);
  }

  private toMetadata(m: FetchedMessage, ref: MessageRef): GmailMetadata {
    return {
      id: ref.id,
      threadId: ref.threadId,
      // X-GM-LABELS leaves out the label of the folder being read, so the folder is added: being in it IS the label.
      labelIds: [...new Set([...(m.labels ?? []).values()].map(labelName).concat(ref.folder))],
      receivedAt: isoOf(m.internalDate),
      headers: headersOf(m),
    };
  }

  async close(): Promise<void> {
    const s = this.session;
    this.session = undefined;
    if (s) await s.logout().catch(() => undefined);
  }
}

/**
 * Defers building the real client (and demanding credentials) until a mail call is actually made, so
 * `inbox candidates`, `inbox admit` and the other database-only commands never need credentials.
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
  getMetadata(ref: MessageRef) {
    return this.c().getMetadata(ref);
  }
  getFull(ref: MessageRef) {
    return this.c().getFull(ref);
  }
  async close() {
    await this.inner?.close();
  }
}
