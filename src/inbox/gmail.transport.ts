/**
 * The mail transport (Gmail over IMAP). Two interfaces, and the difference between them is the
 * access-control model:
 *
 *  - {@link GmailMetadataClient} can list a label's folder, read ENVELOPES (headers) and nothing more. It
 *    has **no method that returns a body**. Everything the candidate path touches is typed as this, so a
 *    body is unreachable for a candidate, not merely unused.
 *  - {@link GmailClient} adds `getFull`, and only the admitted path holds one.
 *
 * The scoping unit is the FOLDER: Gmail exposes every label as an IMAP folder, and a folder is opened
 * only read-only (EXAMINE). `listMessageRefs` REQUIRES a folder: there is no way to express a listing of
 * the whole mailbox, and the real client refuses to open any folder it was not configured with.
 * No call in this repository writes (APPEND, STORE, EXPUNGE, COPY, ...: source-scanned).
 *
 * Tests use a fake implementation fed from committed fixture JSON; nothing here touches the network.
 */

export interface MessageRef {
  /** X-GM-MSGID: Gmail's id for the message, the same in every folder. */
  id: string;
  /** X-GM-THRID. */
  threadId: string;
  /** The folder the listing came from, and the UID the message has THERE. */
  folder: string;
  uid: number;
}

export interface GmailHeaders {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  /** The RFC `Message-ID` header (M4b replies into it). */
  messageId?: string;
  /** `In-Reply-To` and `References`: the chain a correct reply must extend (M4b). */
  inReplyTo?: string;
  /** Not part of ENVELOPE: only the admitted path (which reads headers with the body) has it. */
  references?: string;
  /** Where a reply should go when it is not the sender, and who else was copied. */
  replyTo?: string;
  cc?: string;
}

/** Headers, labels and the received time. No body, no snippet: there is nowhere to put one. */
export interface GmailMetadata {
  id: string;
  threadId: string;
  /** Label NAMES (X-GM-LABELS) plus the folder the message was read from; `\Sent` is `SENT`, `\Draft` is `DRAFT`. */
  labelIds: string[];
  /** ISO-8601, from INTERNALDATE (when it was received, NOT when it was labelled). */
  receivedAt: string;
  headers: GmailHeaders;
}

export interface GmailAttachmentInfo {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** What only the admitted path can read. Attachments are listed (name, type, size), never downloaded. */
export interface GmailFullMessage extends GmailMetadata {
  bodyText: string;
  attachments: GmailAttachmentInfo[];
}

export interface ListQuery {
  /** Required: the folder (label) the listing is scoped to, as LIST reports it. */
  labelId: string;
  /** Only UIDs above this one (the cursor). */
  afterUid?: number;
  /** Narrows by received date (`YYYY-MM-DD`); the folder scopes. */
  since?: string;
  /** At most this many refs, oldest UID first. */
  limit: number;
}

export interface ListPage {
  /** Ascending by UID. */
  refs: MessageRef[];
  uidValidity: string;
  /** More refs exist above the last one returned. */
  hasMore: boolean;
}

export interface GmailMetadataClient {
  /** Resolves a label NAME to its folder path via LIST. Null when there is no such folder (never "everything"). */
  resolveLabelId(name: string): Promise<string | null>;
  listMessageRefs(query: ListQuery): Promise<ListPage>;
  /** ENVELOPE only. */
  getMetadata(ref: MessageRef): Promise<GmailMetadata>;
}

export interface GmailClient extends GmailMetadataClient {
  getFull(ref: MessageRef): Promise<GmailFullMessage>;
  /** Ends the session. Safe to call when nothing was ever connected. */
  close(): Promise<void>;
}
