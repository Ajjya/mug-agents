import { z } from 'zod';
import { documentShape, entityId, isoDate, nonEmpty } from './common.js';

/**
 * The inbox's records. Nothing here is the public corpus: inbound mail is `personal` by construction.
 * The access-control model is stored explicitly (admitted / excluded / candidate threads) rather than
 * inferred from message records, so it reads like what it is.
 */

// ---- triage summary (what is STORED; the LLM-facing schema lives in src/inbox/triage.schema.ts) ----

export const TRIAGE_INTENTS = [
  'speaker_reply',
  'venue_reply',
  'sponsor_enquiry',
  'attendee_question',
  'newsletter_or_noise',
  // Added after the first real run (467 messages: 33% landed in `other`, so the taxonomy did not cover the mailbox).
  'cohost_reply',
  'coorganiser',
  'community_manager',
  'calendar_invite',
  'document_share',
  // Automated mail from a service we use (Meetup, Luma, Slack): operational data about our events, waiting for a parser.
  'platform_notification',
  'other',
] as const;

/**
 * What a contact IS to us, set by a human. A known sender fixes the triage `intent` without a model call.
 * Intents with no role (attendee_question, calendar_invite, document_share, other) are never decided by lookup.
 */
export const CONTACT_ROLES = [
  'speaker',
  'venue',
  'cohost',
  'coorganiser',
  'community_manager',
  'sponsor',
  /**
   * An automated sender from a service we use, whose mail carries operational data about our events
   * (registrations, RSVP counts, relayed messages). Not a person and not noise: kept, cheap, and never
   * treated as correspondence (no task, no chase pause, no speaker link).
   */
  'platform',
  'noise',
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const INTENT_BY_ROLE: Record<ContactRole, (typeof TRIAGE_INTENTS)[number]> = {
  speaker: 'speaker_reply',
  venue: 'venue_reply',
  cohost: 'cohost_reply',
  coorganiser: 'coorganiser',
  community_manager: 'community_manager',
  sponsor: 'sponsor_enquiry',
  platform: 'platform_notification',
  noise: 'newsletter_or_noise',
};

/** How the intent was decided. Absent on summaries stored before this field existed: those were the model. */
export const DECIDED_BY = [
  'model',
  'lookup_speaker',
  'lookup_contact',
  'rule_list_unsubscribe',
  'rule_calendar',
  'rule_sender_list',
] as const;
export type DecidedBy = (typeof DECIDED_BY)[number];
export const TRIAGE_DECISIONS = [
  'accepts',
  'declines',
  'asks_question',
  'sends_material',
  'unclear',
] as const;
export const TRIAGE_CONFIDENCE = ['low', 'medium', 'high'] as const;

export const MentionsSchema = z
  .object({
    dates: z.array(z.string()),
    people: z.array(z.string()),
    organisations: z.array(z.string()),
  })
  .strict();

export const MaterialsSchema = z
  .object({ abstract: z.boolean(), bio: z.boolean(), photo: z.boolean(), slides: z.boolean() })
  .strict();

/**
 * The validated summary. It contains no ids, no status values and no normalised dates: nothing in it
 * could be written straight into a domain record. `mentions` are verbatim spans as the sender wrote
 * them; code interprets them. `attachmentChecks` and `model` are computed in code, never by the model.
 */
export const TriageSummarySchema = z
  .object({
    intent: z.enum(TRIAGE_INTENTS),
    sentiment_decision: z.enum(TRIAGE_DECISIONS),
    mentions: MentionsSchema,
    materials: MaterialsSchema,
    asks: z.array(z.string()),
    needs_human: z.boolean(),
    reason: z.string(),
    confidence: z.enum(TRIAGE_CONFIDENCE),
    attachmentChecks: z.array(z.string()),
    /** `none` when no model was called for this message. */
    model: nonEmpty,
    decidedBy: z.enum(DECIDED_BY).optional(),
  })
  .strict();
export type Mentions = z.infer<typeof MentionsSchema>;
export type TriageSummary = z.infer<typeof TriageSummarySchema>;

// ---- inbound_messages ----

export const AddressSchema = z
  .object({
    name: z.string().optional(),
    // Lower-cased so matching an address is case-insensitive.
    address: z.email().toLowerCase(),
  })
  .strict();
export type Address = z.infer<typeof AddressSchema>;

export const AttachmentSchema = z
  .object({ filename: z.string(), mimeType: z.string(), sizeBytes: z.number().int().min(0) })
  .strict();

/**
 * A body that is really the text of a missing value: the exact strings "undefined" and "null" (ignoring the
 * whitespace around them). The extractor once stored "undefined\r\n" for an HTML-only message; this is the
 * guard that keeps that whole class of bug from being written again.
 */
export const isStringifiedNothing = (text: string): boolean => {
  const t = text.trim();
  return t === 'undefined' || t === 'null';
};

export const TRIAGE_STATES = ['pending', 'done', 'failed'] as const;
export const LINK_STATES = ['unlinked', 'auto', 'confirmed_by_human'] as const;

export const InboundMessageInputSchema = z
  .object({
    gmailId: nonEmpty,
    threadId: nonEmpty,
    /** The `Message-ID` header: M4b replies into it. */
    rfcMessageId: nonEmpty.optional(),
    receivedAt: isoDate,
    from: AddressSchema,
    to: z.array(AddressSchema),
    cc: z.array(AddressSchema).optional(),
    replyTo: z.array(AddressSchema).optional(),
    /** The reply chain, as the headers give it: what M4b must extend to reply into the right thread. */
    inReplyTo: nonEmpty.optional(),
    references: z.array(nonEmpty).optional(),
    subject: z.string(),
    /** The full body. Reachable only through the inbox repository's one explicit raw-body accessor. */
    bodyText: z
      .string()
      .refine(
        (v) => !isStringifiedNothing(v),
        'must be the message text, not the string "undefined" or "null"',
      ),
    /**
     * The body was cut at INBOX_BODY_MAX_CHARS when it was stored. Set only on messages ingested after body
     * normalisation existed (or repaired by `inbox repair-bodies`): absent means "stored as it arrived".
     */
    bodyTruncated: z.boolean().optional(),
    /** Exactly what the provider received (redacted, bounded). */
    bodyRedacted: z.string(),
    bodySnippet: z.string(),
    /** Stored so a later audit can show the label was present. */
    labelIds: z.array(z.string()),
    attachments: z.array(AttachmentSchema),
    /**
     * The `List-Unsubscribe` header, verbatim and bounded (its PRESENCE is what the newsletter rule uses).
     * Absent on messages stored before it was read, until `inbox backfill-structure` has checked them.
     */
    listUnsubscribe: z.string().max(1000).optional(),
    /** A `text/calendar` (or `application/ics`) MIME part is present. Same backfill note as above. */
    hasCalendarPart: z.boolean().optional(),
    /** When listUnsubscribe/hasCalendarPart were read from the mailbox: distinguishes "absent" from "never looked". */
    structureCheckedAt: isoDate.optional(),
    classification: z.literal('personal'),
    triageState: z.enum(TRIAGE_STATES),
    triage: TriageSummarySchema.optional(),
    /** Validation issues only, never the model's raw output. */
    triageFailure: z.array(z.string()).optional(),
    triagedAt: isoDate.optional(),
    linkedSpeakerId: entityId.optional(),
    linkedOrganisationId: entityId.optional(),
    linkedEventId: entityId.optional(),
    linkState: z.enum(LINK_STATES),
  })
  .strict();

/** What every read returns: the document WITHOUT `bodyText`. */
export const InboundMessageViewSchema = InboundMessageInputSchema.omit({ bodyText: true }).extend(
  documentShape,
);
/** Only triage and link state change after creation. */
export const InboundMessagePatchSchema = InboundMessageInputSchema.pick({
  listUnsubscribe: true,
  hasCalendarPart: true,
  structureCheckedAt: true,
  triageState: true,
  triage: true,
  triageFailure: true,
  triagedAt: true,
  linkedSpeakerId: true,
  linkedOrganisationId: true,
  linkedEventId: true,
  linkState: true,
})
  .partial()
  .strict();

export type InboundMessageInput = z.infer<typeof InboundMessageInputSchema>;
export type InboundMessage = z.infer<typeof InboundMessageViewSchema>;
export type InboundMessagePatch = z.infer<typeof InboundMessagePatchSchema>;

// ---- admitted / excluded / candidate threads ----

export const ADMITTED_BY = ['label', 'human'] as const;

/** Once any message of a thread carried the label (or I admitted it), later messages are in scope. */
export const AdmittedThreadInputSchema = z
  .object({ threadId: nonEmpty, admittedAt: isoDate, admittedBy: z.enum(ADMITTED_BY) })
  .strict();
export const AdmittedThreadSchema = AdmittedThreadInputSchema.extend(documentShape);
export const AdmittedThreadPatchSchema = z.object({}).strict();

export const EXCLUSION_STATUSES = ['excluded', 'lifted'] as const;
/** Revocable: lifting is a status, nothing is deleted. */
export const ExcludedThreadInputSchema = z
  .object({
    threadId: nonEmpty,
    reason: nonEmpty,
    excludedAt: isoDate,
    status: z.enum(EXCLUSION_STATUSES),
    liftedAt: isoDate.optional(),
  })
  .strict();
export const ExcludedThreadSchema = ExcludedThreadInputSchema.extend(documentShape);
export const ExcludedThreadPatchSchema = ExcludedThreadInputSchema.pick({
  status: true,
  liftedAt: true,
  reason: true,
  excludedAt: true,
})
  .partial()
  .strict();

export const CANDIDATE_STATES = ['pending', 'admitted', 'dismissed'] as const;
/**
 * A thread carrying only the loose label. Metadata only, in its own collection, so there is no path by
 * which a candidate's record grows a body field: this schema has no field that could hold one, and it
 * is strict.
 */
export const CandidateThreadInputSchema = z
  .object({
    threadId: nonEmpty,
    subject: z.string(),
    from: AddressSchema,
    lastSeenAt: isoDate,
    state: z.enum(CANDIDATE_STATES),
    reason: nonEmpty.optional(),
    decidedAt: isoDate.optional(),
  })
  .strict();
export const CandidateThreadSchema = CandidateThreadInputSchema.extend(documentShape);
export const CandidateThreadPatchSchema = CandidateThreadInputSchema.pick({
  state: true,
  reason: true,
  decidedAt: true,
  lastSeenAt: true,
})
  .partial()
  .strict();

export type AdmittedThread = z.infer<typeof AdmittedThreadSchema>;
export type ExcludedThread = z.infer<typeof ExcludedThreadSchema>;
export type CandidateThread = z.infer<typeof CandidateThreadSchema>;
export type CandidateThreadInput = z.infer<typeof CandidateThreadInputSchema>;
export type AdmittedThreadInput = z.infer<typeof AdmittedThreadInputSchema>;
export type ExcludedThreadInput = z.infer<typeof ExcludedThreadInputSchema>;

// ---- contacts: the outbound allow-list, populated now, enforced in M4b ----

export const CONTACT_SOURCES = ['seed', 'replied_to_us', 'added_by_human'] as const;
/**
 * Being here is a fact about correspondence, not permission to write to anyone: M4b decides what
 * permission means. Populated, never enforced, in this milestone.
 */
export const ContactInputSchema = z
  .object({
    name: z.string().optional(),
    address: z.email().toLowerCase(),
    role: z.enum(CONTACT_ROLES).optional(),
    speakerId: entityId.optional(),
    organisationId: entityId.optional(),
    addedBy: nonEmpty,
    addedAt: isoDate,
    source: z.enum(CONTACT_SOURCES),
  })
  .strict();
export const ContactSchema = ContactInputSchema.extend(documentShape);
export const ContactPatchSchema = ContactInputSchema.pick({
  name: true,
  role: true,
  speakerId: true,
  organisationId: true,
})
  .partial()
  .strict();
export type Contact = z.infer<typeof ContactSchema>;
export type ContactInput = z.infer<typeof ContactInputSchema>;

// ---- the poll cursor ----

/** Where the sweep of ONE label folder stopped: the highest UID processed, under the UIDVALIDITY it was read with. */
export const FolderCursorSchema = z
  .object({
    folder: nonEmpty,
    uidValidity: nonEmpty,
    lastUid: z.number().int().min(0),
  })
  .strict();
export type FolderCursor = z.infer<typeof FolderCursorSchema>;

export const InboxCursorInputSchema = z
  .object({
    key: z.literal('gmail'),
    /**
     * One entry per label folder. A label applied to an old message gives it a NEW, highest UID in that
     * folder at the moment it is applied, so "UIDs above lastUid" is exactly "labelled since the last poll".
     * A changed UIDVALIDITY discards the entry: the folder is swept again (bounded), and the unique
     * Gmail id absorbs what was already stored.
     */
    folders: z.array(FolderCursorSchema).optional(),
    lastPollAt: isoDate.optional(),
    lastUidValidityResetAt: isoDate.optional(),
  })
  .strict();
export const InboxCursorSchema = InboxCursorInputSchema.extend(documentShape);
export const InboxCursorPatchSchema = InboxCursorInputSchema.omit({ key: true }).partial().strict();
export type InboxCursor = z.infer<typeof InboxCursorSchema>;
