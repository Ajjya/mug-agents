import { readFileSync } from 'node:fs';
import {
  type GmailClient,
  type GmailFullMessage,
  type GmailMetadata,
  type GmailThreadRefs,
  HistoryExpiredError,
  type HistoryPage,
  type ListQuery,
  type MessageRef,
} from '../../src/inbox/gmail.transport.js';

export interface FixtureMessage {
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
  self: string;
  labels: { id: string; name: string }[];
  messages: FixtureMessage[];
}

interface HistoryEvent {
  historyId: number;
  type: 'messageAdded' | 'labelAdded';
  messageId: string;
}

export interface Calls {
  resolveLabel: string[];
  list: ListQuery[];
  metadata: string[];
  full: string[];
  thread: string[];
  history: string[];
  profile: number;
}

/**
 * A fake Gmail fed from committed fixture JSON. It RECORDS every call, so a test can assert what was
 * fetched (not just what was stored): which ids had their headers read, which had their body fetched.
 * Levers let a test do what a mailbox does over time: receive a message, apply a label later, let the
 * history id expire, or answer a listing as if the query were wrong.
 */
export class FakeGmail implements GmailClient {
  readonly labels: { id: string; name: string }[];
  readonly self: string;
  private readonly messages = new Map<string, FixtureMessage>();
  private readonly events: HistoryEvent[] = [];
  private historyId = 1000;
  private historyFloor = 0;
  readonly calls: Calls = {
    resolveLabel: [],
    list: [],
    metadata: [],
    full: [],
    thread: [],
    history: [],
    profile: 0,
  };
  /** The page size of listings (Gmail's max is 500); small values make a test page. */
  pageSize = 500;
  /** Simulates a WRONG QUERY: listings ignore the label and return every message in the mailbox. */
  ignoreLabelScope = false;

  constructor(fixture: Fixture) {
    this.labels = structuredClone(fixture.labels);
    this.self = fixture.self;
    for (const m of structuredClone(fixture.messages)) this.messages.set(m.id, m);
  }

  static fromFixture(path = 'test/fixtures/gmail/mailbox.json'): FakeGmail {
    return new FakeGmail(JSON.parse(readFileSync(path, 'utf8')) as Fixture);
  }

  // ---- levers --------------------------------------------------------------------------------

  labelId(name: string): string {
    const l = this.labels.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!l) throw new Error(`fixture has no label ${name}`);
    return l.id;
  }

  /** A human applies a label, possibly days after the message arrived. */
  applyLabel(messageId: string, labelName: string): void {
    const m = this.must(messageId);
    const id = this.labelId(labelName);
    if (!m.labels.includes(id)) m.labels.push(id);
    this.events.push({ historyId: ++this.historyId, type: 'labelAdded', messageId });
  }

  /** A new message arrives (in an existing thread or a new one). */
  receive(message: FixtureMessage): void {
    this.messages.set(message.id, structuredClone(message));
    this.events.push({ historyId: ++this.historyId, type: 'messageAdded', messageId: message.id });
  }

  /** Every history id issued so far is now out of range (HTTP 404). */
  expireHistory(): void {
    this.historyFloor = this.historyId + 1;
  }

  // ---- the client ----------------------------------------------------------------------------

  private must(id: string): FixtureMessage {
    const m = this.messages.get(id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }

  private toMetadata(m: FixtureMessage): GmailMetadata {
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labels],
      receivedAt: m.receivedAt,
      headers: { from: m.from, to: m.to, subject: m.subject, messageId: m.messageId },
    };
  }

  resolveLabelId(name: string): Promise<string | null> {
    this.calls.resolveLabel.push(name);
    const l = this.labels.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return Promise.resolve(l?.id ?? null);
  }

  listMessageRefs(query: ListQuery): Promise<{ refs: MessageRef[]; nextPageToken?: string }> {
    this.calls.list.push({ ...query });
    let all = [...this.messages.values()];
    if (!this.ignoreLabelScope) all = all.filter((m) => m.labels.includes(query.labelId));
    if (query.after) {
      const after = Date.parse(`${query.after.replaceAll('/', '-')}T00:00:00Z`);
      all = all.filter((m) => Date.parse(m.receivedAt) >= after);
    }
    // Gmail lists newest RECEIVED first (not newest labelled).
    all.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const start = query.pageToken ? Number(query.pageToken) : 0;
    const page = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined;
    return Promise.resolve({
      refs: page.map((m) => ({ id: m.id, threadId: m.threadId })),
      ...(next ? { nextPageToken: next } : {}),
    });
  }

  getMetadata(id: string): Promise<GmailMetadata> {
    this.calls.metadata.push(id);
    return Promise.resolve(this.toMetadata(this.must(id)));
  }

  getThreadRefs(threadId: string): Promise<GmailThreadRefs> {
    this.calls.thread.push(threadId);
    return Promise.resolve({
      threadId,
      messages: [...this.messages.values()]
        .filter((m) => m.threadId === threadId)
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
        .map((m) => ({ id: m.id, labelIds: [...m.labels] })),
    });
  }

  getCurrentHistoryId(): Promise<string> {
    this.calls.profile++;
    return Promise.resolve(String(this.historyId));
  }

  listHistory(startHistoryId: string): Promise<HistoryPage> {
    this.calls.history.push(startHistoryId);
    if (Number(startHistoryId) < this.historyFloor)
      return Promise.reject(new HistoryExpiredError());
    const seen = new Set<string>();
    const records = this.events
      .filter((e) => e.historyId > Number(startHistoryId))
      .flatMap((e) => {
        const m = this.messages.get(e.messageId);
        if (!m || seen.has(e.messageId)) return [];
        seen.add(e.messageId);
        return [{ messageId: m.id, threadId: m.threadId, labelIds: [...m.labels] }];
      });
    return Promise.resolve({ records, historyId: String(this.historyId) });
  }

  getFull(id: string): Promise<GmailFullMessage> {
    this.calls.full.push(id);
    const m = this.must(id);
    return Promise.resolve({
      ...this.toMetadata(m),
      bodyText: m.body,
      attachments: structuredClone(m.attachments),
    });
  }
}
