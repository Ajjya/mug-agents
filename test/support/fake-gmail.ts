import { readFileSync } from 'node:fs';
import type {
  GmailClient,
  GmailFullMessage,
  GmailMetadata,
  GmailStructure,
  ListPage,
  ListQuery,
  MessageRef,
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
  inReplyTo?: string;
  references?: string;
  replyTo?: string;
  cc?: string;
  body: string;
  /**
   * The MIME text parts the IMAP fake serves, when a test needs a shape other than one text/plain part:
   * an HTML-only message, a plain part that is literally "undefined", or no text part at all (`[]`).
   */
  bodyParts?: { type: 'text/plain' | 'text/html'; content: string }[];
  attachments: { filename: string; mimeType: string; sizeBytes: number }[];
  /** The `List-Unsubscribe` header, when the fixture message has one. */
  listUnsubscribe?: string;
  /** A text/calendar MIME part exists. */
  hasCalendarPart?: boolean;
}

interface Fixture {
  self: string;
  labels: { id: string; name: string }[];
  messages: FixtureMessage[];
}

export interface Calls {
  resolveLabel: string[];
  list: ListQuery[];
  /** Gmail ids whose ENVELOPE was read / whose body was fetched. */
  metadata: string[];
  full: string[];
  /** Gmail ids whose structure (headers + BODYSTRUCTURE, no body) was read. */
  structure: string[];
  /** Folders opened (EXAMINE). The fake serves nothing else. */
  opened: string[];
  closed: number;
}

/**
 * A fake Gmail fed from committed fixture JSON. It RECORDS every call, so a test can assert what was
 * fetched (not just what was stored): which ids had their headers read, which had their body fetched.
 * It models what Gmail's IMAP does with labels: a label is a FOLDER, and applying it gives the message a
 * NEW, HIGHEST UID in that folder at that moment (verified against a real mailbox: a 2014 message labelled
 * today got the next UID, not one ordered by its date). Levers let a test do what a mailbox does over
 * time: receive a message, apply a label later, recreate a folder (new UIDVALIDITY), or answer a listing as
 * if the query were wrong.
 */
export class FakeGmail implements GmailClient {
  readonly labels: { id: string; name: string }[];
  readonly self: string;
  private readonly messages = new Map<string, FixtureMessage>();
  /** Per folder: message id -> UID. Assigned when the label is applied, never from the message's date. */
  private readonly uids = new Map<string, Map<string, number>>();
  private readonly uidNext = new Map<string, number>();
  private readonly uidValidity = new Map<string, string>();
  readonly calls: Calls = {
    resolveLabel: [],
    list: [],
    metadata: [],
    full: [],
    structure: [],
    opened: [],
    closed: 0,
  };
  /** What a full fetch returns for a message's labels, when it differs from the headers (a label removed in between). */
  private readonly fullLabels = new Map<string, string[]>();
  /** Extra ids a label's listing returns although the messages do not carry it (one stray result, not a whole wrong query). */
  private readonly injected = new Map<string, string[]>();
  /** Labels whose listing ignores the label (a wrong query for ONE label only). */
  private readonly unscoped = new Set<string>();
  /** Simulates a WRONG QUERY: listings ignore the label and return every message in the mailbox. */
  ignoreLabelScope = false;

  constructor(fixture: Fixture) {
    this.labels = structuredClone(fixture.labels);
    this.self = fixture.self;
    const initial = structuredClone(fixture.messages).sort(
      (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
    );
    for (const m of initial) {
      this.messages.set(m.id, m);
      for (const l of m.labels) this.assignUid(l, m.id);
    }
  }

  private assignUid(folder: string, messageId: string): void {
    const map = this.uids.get(folder) ?? new Map<string, number>();
    this.uids.set(folder, map);
    if (map.has(messageId)) return;
    const next = this.uidNext.get(folder) ?? 1;
    map.set(messageId, next);
    this.uidNext.set(folder, next + 1);
  }

  /** A mailbox with the two labels and nothing in it: a test receives exactly the mail it cares about. */
  static empty(): FakeGmail {
    return new FakeGmail({
      self: 'organiser@mug.invalid',
      labels: [
        { id: 'Label_1', name: 'mug-agents' },
        { id: 'Label_2', name: 'mug-maybe' },
      ],
      messages: [],
    });
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
    this.assignUid(id, messageId); // a NEW, HIGHEST uid, however old the message is
  }

  /** A new message arrives (in an existing thread or a new one). */
  receive(message: FixtureMessage): void {
    this.messages.set(message.id, structuredClone(message));
    for (const l of message.labels) this.assignUid(l, message.id);
  }

  /** The folder was deleted and recreated (or Gmail reset it): a new UIDVALIDITY, and every UID is reissued. */
  recreateFolder(labelName: string): void {
    const id = this.labelId(labelName);
    const old = this.uids.get(id) ?? new Map<string, number>();
    this.uids.set(id, new Map());
    this.uidNext.set(id, 1000); // the new numbering has nothing to do with the old one
    this.uidValidity.set(id, `v${String((Number(this.uidValidity.get(id)?.slice(1)) || 1) + 1)}`);
    for (const messageId of [...old.keys()].reverse()) this.assignUid(id, messageId);
  }

  /** For a fake IMAP session served from the same mailbox: every message, and each label folder's UIDs. */
  snapshot(): {
    messages: FixtureMessage[];
    folders: Map<string, { name: string; uidValidity: string; uids: Map<string, number> }>;
  } {
    const folders = new Map<
      string,
      { name: string; uidValidity: string; uids: Map<string, number> }
    >();
    for (const l of this.labels) {
      folders.set(l.id, {
        name: l.name,
        uidValidity: this.uidValidity.get(l.id) ?? 'v1',
        uids: new Map(this.uids.get(l.id) ?? []),
      });
    }
    return { messages: [...this.messages.values()], folders };
  }

  /** What the folder's UIDVALIDITY is now. */
  validityOf(labelName: string): string {
    return this.uidValidity.get(this.labelId(labelName)) ?? 'v1';
  }

  /** Highest UID in the folder (what a cursor would hold). */
  highestUid(labelName: string): number {
    return Math.max(0, ...(this.uids.get(this.labelId(labelName))?.values() ?? []));
  }

  /** The listing for THIS label alone ignores the label and returns the whole mailbox. */
  ignoreScopeFor(labelName: string): void {
    this.unscoped.add(this.labelId(labelName));
  }

  /** The listing for this label will ALSO return these message ids. */
  injectIntoListing(labelName: string, messageIds: string[]): void {
    this.injected.set(this.labelId(labelName), messageIds);
  }

  /** The body fetch for this message reports these label ids (the headers said otherwise). */
  changeLabelsOnFull(messageId: string, labelIds: string[]): void {
    this.fullLabels.set(messageId, labelIds);
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
      headers: {
        from: m.from,
        to: m.to,
        subject: m.subject,
        messageId: m.messageId,
        ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
        ...(m.references ? { references: m.references } : {}),
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        ...(m.cc ? { cc: m.cc } : {}),
      },
    };
  }

  resolveLabelId(name: string): Promise<string | null> {
    this.calls.resolveLabel.push(name);
    const l = this.labels.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return Promise.resolve(l?.id ?? null);
  }

  private refOf(folder: string, m: FixtureMessage, uid: number): MessageRef {
    return { id: m.id, threadId: m.threadId, folder, uid };
  }

  listMessageRefs(query: ListQuery): Promise<ListPage> {
    this.calls.list.push({ ...query });
    this.calls.opened.push(query.labelId);
    const folder = this.uids.get(query.labelId) ?? new Map<string, number>();
    let rows: { m: FixtureMessage; uid: number }[] = [];
    if (this.ignoreLabelScope || this.unscoped.has(query.labelId)) {
      // A WRONG QUERY: the whole mailbox, with made-up UIDs.
      rows = [...this.messages.values()].map((m, i) => ({ m, uid: 5_000_000 + i }));
    } else {
      for (const [id, uid] of folder) {
        const m = this.messages.get(id);
        if (m) rows.push({ m, uid });
      }
      let stray = 0;
      for (const id of this.injected.get(query.labelId) ?? []) {
        const m = this.messages.get(id);
        if (m && !folder.has(id)) rows.push({ m, uid: 6_000_000 + stray++ });
      }
    }
    rows = rows.filter((r) => r.uid > (query.afterUid ?? 0));
    if (query.since) {
      const since = Date.parse(`${query.since}T00:00:00Z`);
      rows = rows.filter((r) => Date.parse(r.m.receivedAt) >= since);
    }
    rows.sort((a, b) => a.uid - b.uid);
    const page = rows.slice(0, query.limit);
    return Promise.resolve({
      refs: page.map((r) => this.refOf(query.labelId, r.m, r.uid)),
      uidValidity: this.uidValidity.get(query.labelId) ?? 'v1',
      hasMore: rows.length > page.length,
    });
  }

  getMetadata(ref: MessageRef): Promise<GmailMetadata> {
    this.calls.metadata.push(ref.id);
    this.calls.opened.push(ref.folder);
    return Promise.resolve(this.toMetadata(this.must(ref.id)));
  }

  getFull(ref: MessageRef): Promise<GmailFullMessage> {
    this.calls.full.push(ref.id);
    this.calls.opened.push(ref.folder);
    const m = this.must(ref.id);
    return Promise.resolve({
      ...this.toMetadata(m),
      labelIds: [...(this.fullLabels.get(m.id) ?? m.labels)],
      bodyText: m.body,
      attachments: structuredClone(m.attachments),
      hasCalendarPart: m.hasCalendarPart ?? false,
      headers: {
        ...this.toMetadata(m).headers,
        ...(m.listUnsubscribe ? { listUnsubscribe: m.listUnsubscribe } : {}),
      },
    });
  }

  getStructure(ref: MessageRef): Promise<GmailStructure> {
    this.calls.structure.push(ref.id);
    this.calls.opened.push(ref.folder);
    const m = this.must(ref.id);
    return Promise.resolve({
      id: m.id,
      hasCalendarPart: m.hasCalendarPart ?? false,
      ...(m.listUnsubscribe ? { listUnsubscribe: m.listUnsubscribe } : {}),
    });
  }

  close(): Promise<void> {
    this.calls.closed++;
    return Promise.resolve();
  }
}
