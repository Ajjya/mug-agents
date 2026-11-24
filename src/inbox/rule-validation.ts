import type { ContactRole, InboundMessage } from '../domain/inbox.schema.js';
import { classify, type Candidate } from './rules.js';

/**
 * Checks the deterministic rules against what the model already said about the same stored messages. Pure:
 * it reads stored summaries and structure, calls nothing, writes nothing.
 *
 * The question it answers is not "are the rules right" but "where do rule and model DISAGREE", because a
 * disagreement is one of two things (the rule is too broad, or the model was wrong) and only a human can say
 * which. So this reports the disagreements one by one and picks no winner.
 */

export interface ValidationInput {
  messages: readonly InboundMessage[];
  speakerEmails: ReadonlySet<string>;
  contactRoles: ReadonlyMap<string, ContactRole>;
  documentShareSenders: readonly string[];
}

export interface Disagreement {
  gmailId: string;
  receivedAt: string;
  sender: string;
  subject: string;
  modelIntent: string;
  rule: Candidate['decidedBy'];
  ruleIntent: string;
}

export interface SenderRow {
  sender: string;
  /** All stored messages from this sender. */
  total: number;
  /** Of those, how many the model called newsletter_or_noise. */
  modelNoise: number;
  /** Of the model-noise ones: how many a rule (any) also calls noise. */
  ruleCaughtNoise: number;
  /** Does a pure sender rule ("everything from this address is noise") fit? Only if ALL their mail is model-noise. */
  senderRuleSafe: boolean;
  /** Other intents the model gave this sender: why a sender rule would misfire. */
  otherIntents: Record<string, number>;
  /** Does every one of their model-noise messages carry List-Unsubscribe? */
  allHaveListUnsubscribe: boolean;
}

export interface ValidationReport {
  total: number;
  /** Messages whose structure (List-Unsubscribe, calendar) has been read: the header rules can only judge these. */
  structureChecked: number;
  structureUnchecked: number;
  modelNoise: number;
  /** Among the model-noise messages: counts by what the RULES say. */
  noiseVerdicts: {
    /** A header/sender rule agrees: noise. */
    caughtAsNoise: number;
    /** No rule matched: only the model knows. */
    notCaught: number;
    /** A rule says something else (calendar_invite, document_share, a known sender's role...). */
    ruleSaysOther: number;
    /** Not judged: structure not read and no lookup applies. */
    unjudged: number;
  };
  /** Of the model-noise messages caught by the header rule: how many by List-Unsubscribe alone. */
  caughtByListUnsubscribe: number;
  senders: SenderRow[];
  /** Model-noise messages from senders that are ALL noise (a sender rule would be safe) / mixed senders (it would not). */
  bySenderRule: { messagesFromNoiseOnlySenders: number; messagesFromMixedSenders: number };
  /** Every message, any model intent, where a rule's intent differs from the model's. */
  disagreements: Disagreement[];
  /** Per rule: how many messages it matched, and how many of those the model agreed with. */
  perRule: Record<string, { matched: number; agreed: number; disagreed: number }>;
  /** Messages the model did not decide on its own (lookups) or never saw: not comparable. */
  notComparable: number;
}

const wasModelOnly = (m: InboundMessage): boolean =>
  m.triage !== undefined && (m.triage.decidedBy === undefined || m.triage.decidedBy === 'model');

export function validateRules(input: ValidationInput): ValidationReport {
  const rows = new Map<string, SenderRow>();
  const perRule: ValidationReport['perRule'] = {};
  const disagreements: Disagreement[] = [];
  const noiseVerdicts = { caughtAsNoise: 0, notCaught: 0, ruleSaysOther: 0, unjudged: 0 };
  let caughtByListUnsubscribe = 0;
  let modelNoise = 0;
  let notComparable = 0;
  let structureChecked = 0;

  for (const m of input.messages) {
    if (m.structureCheckedAt !== undefined) structureChecked++;
    const modelIntent = m.triage?.intent;
    const decided = classify(
      {
        fromAddress: m.from.address,
        listUnsubscribe: m.listUnsubscribe,
        hasCalendarPart: m.hasCalendarPart,
        isSpeaker: input.speakerEmails.has(m.from.address),
        contactRole: input.contactRoles.get(m.from.address),
      },
      input.documentShareSenders,
    );
    const row =
      rows.get(m.from.address) ??
      ({
        sender: m.from.address,
        total: 0,
        modelNoise: 0,
        ruleCaughtNoise: 0,
        senderRuleSafe: true,
        otherIntents: {},
        allHaveListUnsubscribe: true,
      } satisfies SenderRow);
    rows.set(m.from.address, row);
    row.total++;
    const isNoise = modelIntent === 'newsletter_or_noise' && wasModelOnly(m);
    if (!isNoise && modelIntent)
      row.otherIntents[modelIntent] = (row.otherIntents[modelIntent] ?? 0) + 1;
    if (!wasModelOnly(m)) {
      notComparable++;
      continue; // the stored verdict is itself a rule or a lookup: comparing it with a rule proves nothing
    }
    if (isNoise) {
      modelNoise++;
      row.modelNoise++;
      if (m.listUnsubscribe === undefined || m.listUnsubscribe === '')
        row.allHaveListUnsubscribe = false;
    }

    const v = decided.verdict;
    if (v.mode !== 'model') {
      const key = v.decidedBy;
      const stat = (perRule[key] ??= { matched: 0, agreed: 0, disagreed: 0 });
      stat.matched++;
      if (v.intent === modelIntent) stat.agreed++;
      else {
        stat.disagreed++;
        disagreements.push({
          gmailId: m.gmailId,
          receivedAt: m.receivedAt,
          sender: m.from.address,
          subject: m.subject,
          modelIntent: modelIntent ?? 'none',
          rule: key,
          ruleIntent: v.intent,
        });
      }
    }
    if (isNoise) {
      if (v.mode === 'model') {
        if (m.structureCheckedAt === undefined) noiseVerdicts.unjudged++;
        else noiseVerdicts.notCaught++;
      } else if (v.intent === 'newsletter_or_noise') {
        noiseVerdicts.caughtAsNoise++;
        row.ruleCaughtNoise++;
        if (v.decidedBy === 'rule_list_unsubscribe') caughtByListUnsubscribe++;
      } else noiseVerdicts.ruleSaysOther++;
    }
  }

  const senders = [...rows.values()].filter((r) => r.modelNoise > 0);
  for (const r of senders) r.senderRuleSafe = Object.keys(r.otherIntents).length === 0;
  senders.sort((a, b) => b.modelNoise - a.modelNoise);
  return {
    total: input.messages.length,
    structureChecked,
    structureUnchecked: input.messages.length - structureChecked,
    modelNoise,
    noiseVerdicts,
    caughtByListUnsubscribe,
    senders,
    bySenderRule: {
      messagesFromNoiseOnlySenders: senders
        .filter((r) => r.senderRuleSafe)
        .reduce((n, r) => n + r.modelNoise, 0),
      messagesFromMixedSenders: senders
        .filter((r) => !r.senderRuleSafe)
        .reduce((n, r) => n + r.modelNoise, 0),
    },
    disagreements,
    perRule,
    notComparable,
  };
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`);

/** Markdown. It names senders and subjects, so it belongs in a git-ignored place, never in the repository. */
export function renderValidation(r: ValidationReport): string {
  const lines: string[] = [
    "# Rule validation against the model's own verdicts",
    '',
    `${String(r.total)} stored messages; the model called **${String(r.modelNoise)}** of them newsletter_or_noise. ${String(r.structureChecked)} have had their List-Unsubscribe header and calendar part read; ${String(r.structureUnchecked)} have not (the header rules cannot judge those).`,
    '',
    '## The model-noise messages, by what the rules say',
    '',
    '| Rules say | Messages | Share |',
    '| --- | ---: | ---: |',
    `| noise (agrees) | ${String(r.noiseVerdicts.caughtAsNoise)} | ${pct(r.noiseVerdicts.caughtAsNoise, r.modelNoise)} |`,
    `| something else (disagrees) | ${String(r.noiseVerdicts.ruleSaysOther)} | ${pct(r.noiseVerdicts.ruleSaysOther, r.modelNoise)} |`,
    `| no rule matched (only the model knows) | ${String(r.noiseVerdicts.notCaught)} | ${pct(r.noiseVerdicts.notCaught, r.modelNoise)} |`,
    `| not judged (structure never read) | ${String(r.noiseVerdicts.unjudged)} | ${pct(r.noiseVerdicts.unjudged, r.modelNoise)} |`,
    '',
    `Of the agreeing ones, ${String(r.caughtByListUnsubscribe)} are caught by List-Unsubscribe alone.`,
    '',
    '## Would a sender-based rule have caught them?',
    '',
    `A sender rule ("everything from this address is noise") is safe only for a sender whose mail the model called noise EVERY time. ${String(r.bySenderRule.messagesFromNoiseOnlySenders)} of the ${String(r.modelNoise)} model-noise messages come from such senders; ${String(r.bySenderRule.messagesFromMixedSenders)} come from senders that also sent something the model called otherwise, where a sender rule would misfire.`,
    '',
    '| Sender | Messages | Model noise | A rule also says noise | Sender rule safe? | Always List-Unsubscribe? | Other intents from this sender |',
    '| --- | ---: | ---: | ---: | --- | --- | --- |',
    ...r.senders.map(
      (s) =>
        `| ${s.sender} | ${String(s.total)} | ${String(s.modelNoise)} | ${String(s.ruleCaughtNoise)} | ${s.senderRuleSafe ? 'yes' : '**no**'} | ${s.allHaveListUnsubscribe ? 'yes' : 'no'} | ${
          Object.entries(s.otherIntents)
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(', ') || '-'
        } |`,
    ),
    '',
    '## Per rule: matched, and agreed with the model',
    '',
    '| Rule | Matched | Model agreed | Model disagreed |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(r.perRule).map(
      ([k, v]) => `| ${k} | ${String(v.matched)} | ${String(v.agreed)} | ${String(v.disagreed)} |`,
    ),
    '',
    `## Every disagreement (${String(r.disagreements.length)})`,
    '',
    'Neither side is preferred: each row is a message where a rule and the model gave different intents. Decide which was right.',
    '',
    '| Date | Sender | Subject | Model | Rule | Rule says |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.disagreements.map(
      (d) =>
        `| ${d.receivedAt.slice(0, 10)} | ${d.sender} | ${d.subject.replace(/\|/g, '/')} | ${d.modelIntent} | ${d.rule} | ${d.ruleIntent} |`,
    ),
    '',
    `${String(r.notComparable)} messages were left out of the comparison because their stored verdict was itself a rule or a lookup.`,
  ];
  return lines.join('\n');
}
