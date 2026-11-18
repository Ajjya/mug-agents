/**
 * The Gmail transport. Two interfaces, and the difference between them is the access-control model:
 *
 *  - {@link GmailMetadataClient} can list ids BY LABEL, read headers, read a thread's message ids and
 *    labels, and read history. It has **no method that returns a body**. Everything the candidate path
 *    touches is typed as this, so a body is unreachable for a candidate, not merely unused.
 *  - {@link GmailClient} adds `getFull`, and only the admitted path holds one.
 *
 * `listMessageRefs` REQUIRES a label id: there is no way to express an unscoped `messages.list`.
 * Every method is read-only; no Gmail write call exists in this repository (source-scanned).
 *
 * Tests use a fake implementation fed from committed fixture JSON; nothing here touches the network.
 */

export interface MessageRef {
  id: string;
  threadId: string;
}

export interface GmailHeaders {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  /** The RFC `Message-ID` header (M4b replies into it). */
  messageId?: string;
}

/** Headers, labels and the received time. No body, no snippet: there is nowhere to put one. */
export interface GmailMetadata {
  id: string;
  threadId: string;
  labelIds: string[];
  /** ISO-8601, from Gmail's `internalDate` (when it was received, NOT when it was labelled). */
  receivedAt: string;
  headers: GmailHeaders;
}

export interface GmailAttachmentInfo {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** What only the admitted path can read. Attachments are listed (name, type, size), never opened. */
export interface GmailFullMessage extends GmailMetadata {
  bodyText: string;
  attachments: GmailAttachmentInfo[];
}

export interface GmailThreadRefs {
  threadId: string;
  messages: { id: string; labelIds: string[] }[];
}

export interface HistoryRecord {
  messageId: string;
  threadId: string;
  /** Labels the history record reports for the message, when it does. */
  labelIds: string[];
}

export interface HistoryPage {
  records: HistoryRecord[];
  /** The mailbox's current history id as of this response. */
  historyId: string;
  nextPageToken?: string;
}

/** `history.list` answered 404: the start id is out of range. Fall back to the bounded label sweep. */
export class HistoryExpiredError extends Error {
  constructor() {
    super('Gmail history id is no longer available (HTTP 404)');
    this.name = 'HistoryExpiredError';
  }
}

export interface ListQuery {
  /** Required: the label id the listing is scoped to. */
  labelId: string;
  /** `after:` only, as `YYYY/MM/DD`; it narrows, the label scopes. */
  after?: string;
  pageToken?: string;
}

export interface GmailMetadataClient {
  /** Resolves a label NAME to its id. Null when the label does not exist (never "everything"). */
  resolveLabelId(name: string): Promise<string | null>;
  listMessageRefs(query: ListQuery): Promise<{ refs: MessageRef[]; nextPageToken?: string }>;
  getMetadata(id: string): Promise<GmailMetadata>;
  /** Message ids and label ids of a thread: no content. */
  getThreadRefs(threadId: string): Promise<GmailThreadRefs>;
  getCurrentHistoryId(): Promise<string>;
  /** Throws {@link HistoryExpiredError} on HTTP 404. */
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>;
}

export interface GmailClient extends GmailMetadataClient {
  getFull(id: string): Promise<GmailFullMessage>;
}
