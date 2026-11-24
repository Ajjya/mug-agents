import { parseAddressList } from '../../src/inbox/address.js';
import type { FetchedMessage, ImapSession } from '../../src/inbox/imap.client.js';
import { type FakeGmail, type FixtureMessage } from './fake-gmail.js';

/**
 * An IMAP SESSION served from a FakeGmail mailbox, so the REAL client (src/inbox/imap.client.ts) and the
 * real service run end to end and a test counts what crossed the protocol boundary: which folders were
 * opened and how (EXAMINE or SELECT), which fetch items were requested, which body parts were downloaded.
 *
 * It knows INBOX and [Gmail]/All Mail too, holding the whole mailbox, so a client that opened either would
 * be able to read private mail, and the test would see it. Like Gmail, it leaves a folder's own label out
 * of X-GM-LABELS (observed against a real mailbox).
 */
export class FakeImapSession implements ImapSession {
  readonly opened: { path: string; readOnly: boolean }[] = [];
  readonly fetches: { path: string; uids: number[]; items: string[] }[] = [];
  readonly downloads: { path: string; uid: number; part: string }[] = [];
  readonly searches: { path: string; query: Record<string, unknown> }[] = [];
  /** Anything that is not a read: the session has no such methods, so this stays empty by construction. */
  readonly commands: string[] = [];
  connects = 0;
  logouts = 0;
  mailbox: false | { uidValidity: string } = false;
  private current = '';

  constructor(private readonly gmail: FakeGmail) {}

  private folders(): Map<string, { uidValidity: string; messages: Map<number, FixtureMessage> }> {
    const snap = this.gmail.snapshot();
    const out = new Map<string, { uidValidity: string; messages: Map<number, FixtureMessage> }>();
    const byId = new Map(snap.messages.map((m) => [m.id, m]));
    for (const f of snap.folders.values()) {
      const messages = new Map<number, FixtureMessage>();
      for (const [id, uid] of f.uids) {
        const m = byId.get(id);
        if (m) messages.set(uid, m);
      }
      out.set(f.name, { uidValidity: f.uidValidity, messages });
    }
    const inbox = new Map<number, FixtureMessage>();
    snap.messages.filter((m) => m.labels.includes('INBOX')).forEach((m, i) => inbox.set(i + 1, m));
    out.set('INBOX', { uidValidity: '1', messages: inbox });
    const all = new Map<number, FixtureMessage>();
    snap.messages.forEach((m, i) => all.set(i + 1, m));
    out.set('[Gmail]/All Mail', { uidValidity: '1', messages: all });
    return out;
  }

  connect(): Promise<unknown> {
    this.connects++;
    return Promise.resolve();
  }

  list(): Promise<{ path: string }[]> {
    return Promise.resolve([...this.folders().keys()].map((path) => ({ path })));
  }

  getMailboxLock(path: string, options: { readOnly: true }): Promise<{ release(): void }> {
    this.opened.push({ path, readOnly: options.readOnly });
    const f = this.folders().get(path);
    if (!f) return Promise.reject(new Error(`no such folder ${path}`));
    this.current = path;
    this.mailbox = { uidValidity: f.uidValidity };
    return Promise.resolve({ release: () => undefined });
  }

  private here(): Map<number, FixtureMessage> {
    return this.folders().get(this.current)?.messages ?? new Map<number, FixtureMessage>();
  }

  search(query: Record<string, unknown>): Promise<number[] | false> {
    this.searches.push({ path: this.current, query });
    const range = typeof query['uid'] === 'string' ? query['uid'] : '1:*';
    const from = Number(range.split(':')[0]);
    const uids = [...this.here().keys()].sort((a, b) => a - b);
    // `n:*` always contains the highest UID, even when it is below n (IMAP's quirk).
    const hit = uids.filter((u) => u >= from);
    const out = hit.length > 0 ? hit : uids.slice(-1);
    return Promise.resolve(out.length > 0 ? out : false);
  }

  private labelsOf(m: FixtureMessage): Set<string> {
    const names = new Map(this.gmail.labels.map((l) => [l.id, l.name]));
    const out = new Set<string>();
    for (const l of m.labels) {
      const name =
        l === 'INBOX'
          ? '\\Inbox'
          : l === 'SENT'
            ? '\\Sent'
            : l === 'DRAFT'
              ? '\\Draft'
              : names.get(l);
      if (name && name !== this.current) out.add(name); // the folder's own label is left out
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *fetch(
    range: string | number[],
    query: Record<string, unknown>,
  ): AsyncIterable<FetchedMessage> {
    const uids = Array.isArray(range) ? range : [Number(range)];
    this.fetches.push({ path: this.current, uids, items: Object.keys(query) });
    for (const uid of uids) {
      const m = this.here().get(uid);
      if (!m) continue;
      const out: FetchedMessage = { uid };
      if (query['emailId']) out.emailId = m.id;
      if (query['threadId']) out.threadId = m.threadId;
      if (query['labels']) out.labels = this.labelsOf(m);
      if (query['internalDate']) out.internalDate = new Date(m.receivedAt);
      if (query['envelope']) {
        out.envelope = {
          subject: m.subject,
          messageId: m.messageId,
          ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
          date: new Date(m.receivedAt),
          from: parseAddressList(m.from),
          to: parseAddressList(m.to),
          cc: parseAddressList(m.cc),
          replyTo: parseAddressList(m.replyTo),
        };
      }
      if (query['bodyStructure'] && m.bodyParts) {
        out.bodyStructure = {
          type: 'multipart/alternative',
          childNodes: [
            ...m.bodyParts.map((p, i) => ({
              type: p.type,
              part: String(i + 1),
              size: p.content.length,
            })),
            ...m.attachments.map((a, i) => ({
              type: a.mimeType,
              part: String((m.bodyParts?.length ?? 0) + i + 1),
              disposition: 'attachment',
              dispositionParameters: { filename: a.filename },
              size: a.sizeBytes,
            })),
          ],
        };
      } else if (query['bodyStructure']) {
        out.bodyStructure =
          m.attachments.length === 0
            ? { type: 'text/plain', size: m.body.length }
            : {
                type: 'multipart/mixed',
                childNodes: [
                  { type: 'text/plain', part: '1', size: m.body.length },
                  ...m.attachments.map((a, i) => ({
                    type: a.mimeType,
                    part: String(i + 2),
                    disposition: 'attachment',
                    dispositionParameters: { filename: a.filename },
                    size: a.sizeBytes,
                  })),
                ],
              };
      }
      if (query['headers'] && m.references)
        out.headers = Buffer.from(`References: ${m.references}\r\n`);
      yield out;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async download(
    range: string,
    part: string,
  ): Promise<{ content?: AsyncIterable<Buffer | string> }> {
    const uid = Number(range);
    this.downloads.push({ path: this.current, uid, part });
    const m = this.here().get(uid);
    if (!m) return {};
    if (m.bodyParts) {
      const p = m.bodyParts[Number(part) - 1];
      return p ? { content: [Buffer.from(p.content)] as unknown as AsyncIterable<Buffer> } : {};
    }
    if (part !== '1') return {};
    const body = Buffer.from(m.body);
    return { content: [body] as unknown as AsyncIterable<Buffer> };
  }

  logout(): Promise<unknown> {
    this.logouts++;
    return Promise.resolve();
  }
}
