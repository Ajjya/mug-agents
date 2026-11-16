import type { MessageKind, MessageStatus } from '../../domain/message.schema.js';
import type { SpeakerStatus } from '../../domain/speaker.schema.js';

/**
 * decideActions: the speaker pipeline's decisions, as a pure function. No model, no I/O, no clock of
 * its own: `now` is an input. The model is only ever asked to word a message this function decided.
 *
 * Every rule is a row in {@link RULES}. Timing is in UTC calendar days relative to the event day.
 */

const DAY_MS = 86_400_000;

export interface ChasePolicy {
  /** Sent chases of one kind per speaker per event before the agent stops and creates a task. */
  chaseMaxRounds: number;
  /** Days since the last SENT message of the thread before the next chase is due. */
  chaseMinIntervalDays: number;
  /** Drafts one run may produce, whatever the backlog. */
  maxDraftsPerRun: number;
}

export interface PipelineSpeaker {
  id: string;
  name: string;
  status: SpeakerStatus;
  /** `speaker.bio` is filled in. The agent never writes it; a human does. */
  hasBio: boolean;
  /** `speaker.photoUrl` is filled in. */
  hasPhoto: boolean;
}

/** A message already in the `messages` collection for this event. */
export interface PipelineMessage {
  id: string;
  speakerId: string;
  kind: MessageKind;
  round: number;
  status: MessageStatus;
  /** Set when a human marked it sent. Chases are measured from here and nowhere else. */
  sentAt?: string;
}

export interface PipelineInput {
  now: Date;
  /** The event's date (ISO). Without one nothing is scheduled. */
  eventDate: string | undefined;
  speakers: readonly PipelineSpeaker[];
  messages: readonly PipelineMessage[];
  policy: ChasePolicy;
}

export interface PlannedAction {
  speakerId: string;
  kind: MessageKind;
  round: number;
  reason: string;
  /** The day it became due (YYYY-MM-DD). Oldest first when the per-run cap cuts the list. */
  dueOn: string;
}

/** At the chase limit: no message, a task for a human instead. */
export interface BlockedItem {
  speakerId: string;
  kind: MessageKind;
  roundsSent: number;
  reason: string;
}

/** An unsent draft that no longer applies (the speaker's status or data moved on). */
export interface SupersededItem {
  messageId: string;
  reason: string;
}

/** Why a kind that applies to a speaker produced nothing this run (for `speakers list`). */
export interface WaitingItem {
  speakerId: string;
  kind: MessageKind;
  /** Due from this day, when it is a date that is not reached yet. */
  dueOn?: string;
  why: string;
}

export interface Decision {
  actions: PlannedAction[];
  /** Due, but over `maxDraftsPerRun`: they come up again on the next run. */
  deferred: PlannedAction[];
  blocked: BlockedItem[];
  supersede: SupersededItem[];
  waiting: WaitingItem[];
  notes: string[];
}

/**
 * The decision table (M3b spec §5.2, with the answers settled before coding):
 *  - `invited` is chased with its own kind, `chase_reply`, so it does not use up abstract rounds;
 *  - bio/photo come from `speaker.bio` / `speaker.photoUrl` and are chased in `confirmed` and
 *    `abstract_received`;
 *  - slides are chased from T-1w (spec: T-2d).
 * `from` is the first day (event day + offsetDays) the row can fire; pre-event rows stop on the event day.
 */
export const RULES = [
  { status: 'idea', kind: 'invitation', offsetDays: -42, label: 'T-6w' },
  { status: 'invited', kind: 'chase_reply', offsetDays: null, label: 'after the invitation' },
  { status: 'confirmed', kind: 'chase_abstract', offsetDays: -28, label: 'T-4w' },
  { status: 'confirmed', kind: 'chase_bio', offsetDays: -21, label: 'T-3w' },
  { status: 'confirmed', kind: 'chase_photo', offsetDays: -21, label: 'T-3w' },
  { status: 'abstract_received', kind: 'chase_bio', offsetDays: -21, label: 'T-3w' },
  { status: 'abstract_received', kind: 'chase_photo', offsetDays: -21, label: 'T-3w' },
  { status: 'abstract_received', kind: 'chase_slides', offsetDays: -7, label: 'T-1w' },
  { status: 'slides_received', kind: 'thank_you', offsetDays: 1, label: 'T+1d' },
] as const satisfies readonly {
  status: SpeakerStatus;
  kind: MessageKind;
  offsetDays: number | null;
  label: string;
}[];

export type Rule = (typeof RULES)[number];

/** Kinds that apply in a status (nothing for `declined` and `thanked`). */
export function kindsFor(status: SpeakerStatus): MessageKind[] {
  return RULES.filter((r) => r.status === status).map((r) => r.kind);
}

const utcDay = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (fromMs: number, toMs: number): number => Math.floor((toMs - fromMs) / DAY_MS);

const KIND_ORDER: readonly MessageKind[] = [
  'thank_you',
  'chase_slides',
  'chase_abstract',
  'chase_bio',
  'chase_photo',
  'chase_reply',
  'invitation',
];

const PENDING: readonly MessageStatus[] = ['draft', 'approved'];

const latestSent = (msgs: readonly PipelineMessage[]): PipelineMessage | undefined =>
  msgs
    .filter((m) => m.status === 'sent' && m.sentAt !== undefined)
    .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''))
    .at(-1);

/** A kind's data is already in: nothing to chase. */
function satisfied(speaker: PipelineSpeaker, kind: MessageKind): boolean {
  if (kind === 'chase_bio') return speaker.hasBio;
  if (kind === 'chase_photo') return speaker.hasPhoto;
  return false;
}

export function decideActions(input: PipelineInput): Decision {
  const { policy } = input;
  if (!Number.isInteger(policy.chaseMaxRounds) || policy.chaseMaxRounds < 1)
    throw new RangeError('chaseMaxRounds must be an integer >= 1');
  if (!Number.isInteger(policy.chaseMinIntervalDays) || policy.chaseMinIntervalDays < 1)
    throw new RangeError('chaseMinIntervalDays must be an integer >= 1');
  if (policy.maxDraftsPerRun < 0) throw new RangeError('maxDraftsPerRun must be >= 0');

  const out: Decision = {
    actions: [],
    deferred: [],
    blocked: [],
    supersede: [],
    waiting: [],
    notes: [],
  };
  const today = utcDay(input.now);
  const eventMs = input.eventDate === undefined ? Number.NaN : new Date(input.eventDate).getTime();
  const hasDate = !Number.isNaN(eventMs);
  const eventDay = hasDate ? utcDay(new Date(eventMs)) : Number.NaN;
  if (!hasDate) out.notes.push('The event has no date: nothing is scheduled until it has one.');

  const due: PlannedAction[] = [];
  const speakers = [...input.speakers].sort((a, b) => a.id.localeCompare(b.id));

  for (const speaker of speakers) {
    const mine = input.messages.filter((m) => m.speakerId === speaker.id);
    const applicable = kindsFor(speaker.status).filter((k) => !satisfied(speaker, k));

    // Unsent drafts whose purpose is gone: the status moved on, or the data arrived.
    for (const m of mine) {
      if (!PENDING.includes(m.status) || applicable.includes(m.kind)) continue;
      out.supersede.push({
        messageId: m.id,
        reason: satisfied(speaker, m.kind)
          ? `${m.kind.replace('chase_', '')} is now on file`
          : `speaker is now ${speaker.status}`,
      });
    }
    if (!hasDate) continue;

    for (const rule of RULES.filter((r) => r.status === speaker.status)) {
      const kind = rule.kind;
      if (satisfied(speaker, kind)) continue;
      const ofKind = mine.filter((m) => m.kind === kind);
      const wait = (why: string, dueOn?: string): void => {
        out.waiting.push({ speakerId: speaker.id, kind, why, ...(dueOn ? { dueOn } : {}) });
      };
      const pending = ofKind.find((m) => PENDING.includes(m.status));
      if (pending) {
        wait(`draft ${pending.id} (${pending.status}) has not been marked sent`);
        continue;
      }
      const latest = [...ofKind].sort((a, b) => a.round - b.round).at(-1);
      if (latest?.status === 'rejected') {
        wait(`round ${String(latest.round)} was rejected at review; nothing more of this kind`);
        continue;
      }
      const nextRound = (latest?.round ?? 0) + 1;
      const from = rule.offsetDays === null ? null : eventDay + rule.offsetDays * DAY_MS;

      // ---- one-off messages: the invitation and the thank-you ----
      if (kind === 'invitation' || kind === 'thank_you') {
        if (ofKind.some((m) => m.status === 'sent')) continue; // already went out
        if (from !== null && today < from) {
          wait(`not before ${rule.label}`, ymd(from));
          continue;
        }
        if (kind === 'invitation' && today >= eventDay) {
          wait('the event day has passed');
          continue;
        }
        due.push({
          speakerId: speaker.id,
          kind,
          round: nextRound,
          dueOn: ymd(from ?? today),
          reason:
            kind === 'invitation'
              ? `status idea and ${rule.label} reached (${ymd(from ?? today)})`
              : `slides received and the event is over (${rule.label}, ${ymd(from ?? today)})`,
        });
        continue;
      }

      // ---- chases ----
      if (today >= eventDay) {
        wait('the event day has come: no more chases');
        continue;
      }
      if (from !== null && today < from) {
        wait(`not before ${rule.label}`, ymd(from));
        continue;
      }
      let anchor: PipelineMessage | undefined;
      if (kind === 'chase_reply') {
        // A chase follows a SENT invitation; a draft nobody sent is never chased.
        const invitationSent = mine.some((m) => m.kind === 'invitation' && m.status === 'sent');
        if (!invitationSent) {
          wait('the invitation has not been marked sent');
          continue;
        }
        anchor = latestSent(mine.filter((m) => m.kind === 'invitation' || m.kind === kind));
      } else {
        anchor = latestSent(ofKind);
      }
      const sent = ofKind.filter((m) => m.status === 'sent').length;
      const anchorDay = anchor?.sentAt ? utcDay(new Date(anchor.sentAt)) : undefined;
      const elapsed = anchorDay === undefined ? undefined : daysBetween(anchorDay, today);
      const intervalOk = elapsed === undefined || elapsed >= policy.chaseMinIntervalDays;
      const nextOn =
        anchorDay === undefined ? undefined : anchorDay + policy.chaseMinIntervalDays * DAY_MS;
      const since =
        anchor?.sentAt === undefined
          ? ''
          : `last ${anchor.kind} sent ${anchor.sentAt.slice(0, 10)} (${String(elapsed)} days ago)`;

      if (sent >= policy.chaseMaxRounds) {
        // The last chase gets its full interval to be answered before a human is asked to call.
        if (!intervalOk) {
          wait(`${since}; at the chase limit, waiting out the interval`, ymd(nextOn ?? today));
          continue;
        }
        out.blocked.push({
          speakerId: speaker.id,
          kind,
          roundsSent: sent,
          reason: `${String(sent)} ${kind} sent, ${since}, still ${speaker.status}: chase limit ${String(policy.chaseMaxRounds)} reached`,
        });
        continue;
      }
      if (!intervalOk) {
        wait(
          `${since}; next chase due after ${String(policy.chaseMinIntervalDays)} days`,
          ymd(nextOn ?? today),
        );
        continue;
      }
      const reason = [
        `status ${speaker.status}`,
        from === null ? '' : `${rule.label} reached`,
        since,
        `chase ${String(sent + 1)} of ${String(policy.chaseMaxRounds)}`,
      ]
        .filter(Boolean)
        .join(', ');
      due.push({
        speakerId: speaker.id,
        kind,
        round: nextRound,
        reason,
        dueOn: ymd(
          Math.max(...[from, nextOn].filter((x): x is number => typeof x === 'number'), 0) || today,
        ),
      });
    }
  }

  due.sort(
    (a, b) =>
      a.dueOn.localeCompare(b.dueOn) ||
      a.speakerId.localeCompare(b.speakerId) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
  out.actions = due.slice(0, policy.maxDraftsPerRun);
  out.deferred = due.slice(policy.maxDraftsPerRun);
  if (out.deferred.length > 0) {
    out.notes.push(
      `${String(due.length)} messages are due; MAX_DRAFTS_PER_RUN is ${String(policy.maxDraftsPerRun)}, so ${String(out.deferred.length)} wait for the next run.`,
    );
  }
  return out;
}
