import {
  INTENT_BY_ROLE,
  type ContactRole,
  type DecidedBy,
  type TriageSummary,
} from '../domain/inbox.schema.js';

/**
 * Decide the intent BEFORE asking a model (the first real run: 56% noise, 33% `other`, and every message
 * went to the provider). Pure and deterministic: no I/O, no model, nothing here sees a body.
 *
 * Order of precedence, and why:
 *  1. a sender a human has told us about (a contact's `role`, else a speaker's email): that is knowledge,
 *     the rest are inferences from headers. It fixes `intent`; the model is still asked for the rest,
 *     EXCEPT for role `noise`, which has nothing left to ask;
 *  2. a calendar MIME part (`text/calendar` / `application/ics`): `calendar_invite`;
 *  3. a sender on the configurable document-share list: `document_share`;
 *  4. a `List-Unsubscribe` header: `newsletter_or_noise`.
 * Anything else goes to the model for everything.
 *
 * When two of these match and would give DIFFERENT intents, the earlier one wins and the other is
 * reported in `overridden`: the disagreement is data, never silently resolved.
 */

export interface SenderFacts {
  fromAddress: string;
  /** The `List-Unsubscribe` header, if the message had one. */
  listUnsubscribe?: string | undefined;
  hasCalendarPart?: boolean | undefined;
  /** The sender's address is a seeded speaker's email. */
  isSpeaker: boolean;
  contactRole?: ContactRole | undefined;
}

export interface Candidate {
  decidedBy: Exclude<DecidedBy, 'model'>;
  intent: TriageSummary['intent'];
}

export type Verdict =
  /** Intent decided, no model call at all. */
  | { mode: 'rule'; intent: TriageSummary['intent']; decidedBy: Candidate['decidedBy'] }
  /** Intent decided; the model is asked for sentiment, materials, asks and needs_human only. */
  | { mode: 'fixed-intent'; intent: TriageSummary['intent']; decidedBy: Candidate['decidedBy'] }
  /** Unknown sender, no rule: the model decides everything. */
  | { mode: 'model' };

export interface Classification {
  verdict: Verdict;
  /** Later matches whose intent differs from the winner's: rule-vs-lookup (or rule-vs-rule) disagreements. */
  overridden: Candidate[];
}

/** Exact address, or `@domain.tld` for a whole domain. Lower-cased; blanks ignored. */
export function parseSenderList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function senderOnList(address: string, list: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  const domain = a.slice(a.lastIndexOf('@'));
  return list.some((e) => (e.startsWith('@') ? domain === e : a === e));
}

/** Every classification that applies, strongest first. */
export function candidates(f: SenderFacts, documentShareSenders: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  if (f.contactRole) {
    out.push({ decidedBy: 'lookup_contact', intent: INTENT_BY_ROLE[f.contactRole] });
  } else if (f.isSpeaker) {
    out.push({ decidedBy: 'lookup_speaker', intent: 'speaker_reply' });
  }
  if (f.hasCalendarPart === true)
    out.push({ decidedBy: 'rule_calendar', intent: 'calendar_invite' });
  if (senderOnList(f.fromAddress, documentShareSenders)) {
    out.push({ decidedBy: 'rule_sender_list', intent: 'document_share' });
  }
  if (f.listUnsubscribe !== undefined && f.listUnsubscribe.trim() !== '') {
    out.push({ decidedBy: 'rule_list_unsubscribe', intent: 'newsletter_or_noise' });
  }
  return out;
}

export function classify(f: SenderFacts, documentShareSenders: readonly string[]): Classification {
  const all = candidates(f, documentShareSenders);
  const winner = all[0];
  if (!winner) return { verdict: { mode: 'model' }, overridden: [] };
  const isLookup = winner.decidedBy === 'lookup_contact' || winner.decidedBy === 'lookup_speaker';
  // A lookup fixes the intent and still asks the model for the rest, except `noise`: nothing left to ask.
  const noModel = !isLookup || winner.intent === 'newsletter_or_noise';
  return {
    verdict: {
      mode: noModel ? 'rule' : 'fixed-intent',
      intent: winner.intent,
      decidedBy: winner.decidedBy,
    },
    overridden: all.slice(1).filter((c) => c.intent !== winner.intent),
  };
}

const REASON: Record<Candidate['decidedBy'], string> = {
  lookup_speaker: 'sender is a known speaker',
  lookup_contact: 'sender is a known contact with a role',
  rule_calendar: 'the message carries a calendar (text/calendar) part',
  rule_sender_list: 'sender is on the document-share sender list',
  rule_list_unsubscribe: 'the message has a List-Unsubscribe header',
};

/** The summary of a message that never reached a model. Nothing here is guessed: unknowns are empty. */
export function ruleSummary(
  intent: TriageSummary['intent'],
  decidedBy: Candidate['decidedBy'],
): TriageSummary {
  return {
    intent,
    sentiment_decision: 'unclear',
    mentions: { dates: [], people: [], organisations: [] },
    materials: { abstract: false, bio: false, photo: false, slides: false },
    asks: [],
    needs_human: false,
    reason: `Decided by rule, no model: ${REASON[decidedBy]}.`,
    confidence: 'high',
    attachmentChecks: [],
    model: 'none',
    decidedBy,
  };
}
