import { describe, expect, it } from 'vitest';
import { blockedTaskTitle } from '../../src/agents/speakers/speakers.store.js';
import {
  type ChasePolicy,
  type Decision,
  type PipelineMessage,
  type PipelineSpeaker,
  decideActions,
} from '../../src/agents/speakers/decide.js';
import type { MessageKind, MessageStatus } from '../../src/domain/message.schema.js';
import type { SpeakerStatus } from '../../src/domain/speaker.schema.js';

/** Event day: Saturday 12 December 2026. T-6w = 31 Oct, T-4w = 14 Nov, T-3w = 21 Nov, T-1w = 5 Dec. */
const EVENT = '2026-12-12T00:00:00.000Z';
const POLICY: ChasePolicy = { chaseMaxRounds: 2, chaseMinIntervalDays: 7, maxDraftsPerRun: 10 };
const S = 's'.repeat(24);

const at = (day: string): Date => new Date(`${day}T09:30:00.000Z`);

const speaker = (status: SpeakerStatus, over: Partial<PipelineSpeaker> = {}): PipelineSpeaker => ({
  id: S,
  name: 'Wendeline Gooseberry',
  status,
  hasBio: true,
  hasPhoto: true,
  ...over,
});

let n = 0;
const msg = (
  kind: MessageKind,
  status: MessageStatus,
  sentDay?: string,
  round = 1,
): PipelineMessage => ({
  id: `m${String(++n)}`,
  speakerId: S,
  kind,
  round,
  status,
  ...(sentDay ? { sentAt: `${sentDay}T16:00:00.000Z` } : {}),
});

function decide(
  day: string,
  s: PipelineSpeaker,
  messages: PipelineMessage[] = [],
  policy: ChasePolicy = POLICY,
): Decision {
  return decideActions({ now: at(day), eventDate: EVENT, speakers: [s], messages, policy });
}

const planned = (d: Decision) => d.actions.map((a) => `${a.kind}#${String(a.round)}`);

interface Row {
  name: string;
  day: string;
  speaker: PipelineSpeaker;
  messages?: PipelineMessage[];
  actions: string[];
  blocked?: string[];
  supersede?: number;
}

// Every row of the decision table, with the day before and the day of each boundary.
const ROWS: Row[] = [
  // ---- idea -> invitation at T-6w ----
  { name: 'idea, T-6w minus 1 day', day: '2026-10-30', speaker: speaker('idea'), actions: [] },
  { name: 'idea, T-6w', day: '2026-10-31', speaker: speaker('idea'), actions: ['invitation#1'] },
  {
    name: 'idea, T-4d: the last day an invitation can give 3 days notice',
    day: '2026-12-08',
    speaker: speaker('idea'),
    actions: ['invitation#1'],
  },
  {
    name: 'idea, T-3d: too close to invite',
    day: '2026-12-09',
    speaker: speaker('idea'),
    actions: [],
  },
  { name: 'idea, event day', day: '2026-12-12', speaker: speaker('idea'), actions: [] },
  {
    name: 'idea, invitation drafted, not sent',
    day: '2026-11-01',
    speaker: speaker('idea'),
    messages: [msg('invitation', 'draft')],
    actions: [],
  },
  {
    name: 'idea again (parked) after an invitation was sent',
    day: '2026-11-20',
    speaker: speaker('idea'),
    messages: [msg('invitation', 'sent', '2026-11-01')],
    actions: [],
  },
  {
    name: 'idea, invitation rejected at review',
    day: '2026-11-20',
    speaker: speaker('idea'),
    messages: [msg('invitation', 'rejected')],
    actions: [],
  },
  // ---- invited -> chase_reply, 7 days after the last sent message ----
  {
    name: 'invited, invitation never marked sent',
    day: '2026-11-20',
    speaker: speaker('invited'),
    actions: [],
  },
  {
    name: 'invited, invitation sent 6 days ago',
    day: '2026-11-07',
    speaker: speaker('invited'),
    messages: [msg('invitation', 'sent', '2026-11-01')],
    actions: [],
  },
  {
    name: 'invited, invitation sent 7 days ago',
    day: '2026-11-08',
    speaker: speaker('invited'),
    messages: [msg('invitation', 'sent', '2026-11-01')],
    actions: ['chase_reply#1'],
  },
  {
    name: 'invited, chase 1 drafted, not sent: no second chase',
    day: '2026-11-20',
    speaker: speaker('invited'),
    messages: [msg('invitation', 'sent', '2026-11-01'), msg('chase_reply', 'draft')],
    actions: [],
  },
  {
    name: 'invited, chase 1 sent 6 days ago',
    day: '2026-11-14',
    speaker: speaker('invited'),
    messages: [msg('invitation', 'sent', '2026-11-01'), msg('chase_reply', 'sent', '2026-11-08')],
    actions: [],
  },
  {
    name: 'invited, chase 1 sent 7 days ago',
    day: '2026-11-15',
    speaker: speaker('invited'),
    messages: [msg('invitation', 'sent', '2026-11-01'), msg('chase_reply', 'sent', '2026-11-08')],
    actions: ['chase_reply#2'],
  },
  {
    name: 'invited, 2 chases sent, last 6 days ago: limit, waiting out the interval',
    day: '2026-11-21',
    speaker: speaker('invited'),
    messages: [
      msg('invitation', 'sent', '2026-11-01'),
      msg('chase_reply', 'sent', '2026-11-08', 1),
      msg('chase_reply', 'sent', '2026-11-15', 2),
    ],
    actions: [],
  },
  {
    name: 'invited, 2 chases sent, last 7 days ago: blocked, a task',
    day: '2026-11-22',
    speaker: speaker('invited'),
    messages: [
      msg('invitation', 'sent', '2026-11-01'),
      msg('chase_reply', 'sent', '2026-11-08', 1),
      msg('chase_reply', 'sent', '2026-11-15', 2),
    ],
    actions: [],
    blocked: ['chase_reply'],
  },
  {
    name: 'invited, event day, no reply: a task, not silence',
    day: '2026-12-12',
    speaker: speaker('invited'),
    messages: [msg('invitation', 'sent', '2026-11-01')],
    actions: [],
    blocked: ['chase_reply'],
  },
  {
    name: 'invited, the day after the event: nothing',
    day: '2026-12-13',
    speaker: speaker('invited'),
    messages: [msg('invitation', 'sent', '2026-11-01')],
    actions: [],
  },
  // ---- confirmed -> abstract at T-4w, bio/photo at T-3w ----
  {
    name: 'confirmed, T-4w minus 1',
    day: '2026-11-13',
    speaker: speaker('confirmed'),
    actions: [],
  },
  {
    name: 'confirmed, T-4w',
    day: '2026-11-14',
    speaker: speaker('confirmed'),
    actions: ['chase_abstract#1'],
  },
  {
    name: 'confirmed, abstract chase sent 6 days ago',
    day: '2026-11-20',
    speaker: speaker('confirmed'),
    messages: [msg('chase_abstract', 'sent', '2026-11-14')],
    actions: [],
  },
  {
    name: 'confirmed, abstract chase sent 7 days ago',
    day: '2026-11-21',
    speaker: speaker('confirmed'),
    messages: [msg('chase_abstract', 'sent', '2026-11-14')],
    actions: ['chase_abstract#2'],
  },
  {
    name: 'confirmed, bio and photo missing, T-3w minus 1',
    day: '2026-11-20',
    speaker: speaker('confirmed', { hasBio: false, hasPhoto: false }),
    messages: [msg('chase_abstract', 'sent', '2026-11-14')],
    actions: [],
  },
  {
    name: 'confirmed, bio and photo missing, T-3w',
    day: '2026-11-21',
    speaker: speaker('confirmed', { hasBio: false, hasPhoto: false }),
    messages: [msg('chase_abstract', 'sent', '2026-11-14')],
    actions: ['chase_abstract#2', 'chase_bio#1', 'chase_photo#1'],
  },
  {
    name: 'confirmed, only the photo missing, T-3w',
    day: '2026-11-21',
    speaker: speaker('confirmed', { hasPhoto: false }),
    messages: [msg('chase_abstract', 'draft')],
    actions: ['chase_photo#1'],
  },
  // ---- abstract_received -> slides at T-1w (spec: T-2d), bio/photo still chased ----
  {
    name: 'abstract received, T-1w minus 1',
    day: '2026-12-04',
    speaker: speaker('abstract_received'),
    actions: [],
  },
  {
    name: 'abstract received, T-1w',
    day: '2026-12-05',
    speaker: speaker('abstract_received'),
    actions: ['chase_slides#1'],
  },
  {
    name: 'abstract received, bio missing at T-3w',
    day: '2026-11-21',
    speaker: speaker('abstract_received', { hasBio: false }),
    actions: ['chase_bio#1'],
  },
  {
    name: 'abstract received: an unsent abstract chase is superseded',
    day: '2026-11-21',
    speaker: speaker('abstract_received'),
    messages: [msg('chase_abstract', 'approved')],
    actions: [],
    supersede: 1,
  },
  // ---- slides_received -> thank_you at T+1d ----
  {
    name: 'slides received, event day',
    day: '2026-12-12',
    speaker: speaker('slides_received'),
    actions: [],
  },
  {
    name: 'slides received, T+1d',
    day: '2026-12-13',
    speaker: speaker('slides_received'),
    actions: ['thank_you#1'],
  },
  {
    name: 'slides received, thank-you already sent',
    day: '2026-12-20',
    speaker: speaker('slides_received'),
    messages: [msg('thank_you', 'sent', '2026-12-13')],
    actions: [],
  },
  // ---- terminal-ish statuses ----
  {
    name: 'declined: nothing, and pending drafts are superseded',
    day: '2026-11-21',
    speaker: speaker('declined', { hasBio: false }),
    messages: [msg('invitation', 'sent', '2026-11-01'), msg('chase_reply', 'draft')],
    actions: [],
    supersede: 1,
  },
  { name: 'thanked: nothing', day: '2026-12-20', speaker: speaker('thanked'), actions: [] },
];

describe('decideActions: the decision table', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    const d = decide(row.day, row.speaker, row.messages);
    expect(planned(d)).toEqual(row.actions);
    expect(d.blocked.map((b) => b.kind)).toEqual(row.blocked ?? []);
    expect(d.supersede).toHaveLength(row.supersede ?? 0);
  });

  it('every planned action carries a reason and the day it became due', () => {
    const d = decide('2026-11-21', speaker('confirmed', { hasBio: false }), [
      msg('chase_abstract', 'sent', '2026-11-14'),
    ]);
    expect(d.actions.map((a) => [a.kind, a.dueOn])).toEqual([
      ['chase_abstract', '2026-11-21'],
      ['chase_bio', '2026-11-21'],
    ]);
    expect(d.actions[0]?.reason).toMatch(/chase 2 of 2/);
    expect(d.actions[0]?.reason).toMatch(/7 days ago/);
  });

  it('a filled-in bio supersedes the unsent bio chase', () => {
    const d = decide('2026-11-22', speaker('confirmed'), [msg('chase_bio', 'draft')]);
    expect(d.supersede[0]?.reason).toMatch(/bio is now on file/);
  });

  it('says why a kind is waiting, with the day it becomes due', () => {
    const d = decide('2026-10-01', speaker('idea'));
    expect(d.waiting).toEqual([
      { speakerId: S, kind: 'invitation', dueOn: '2026-10-31', why: 'not before T-6w' },
    ]);
  });
});

describe('decideActions: chase policy', () => {
  it('CHASE_MAX_ROUNDS: a third chase is never planned; the limit produces a task', () => {
    const sent = [
      msg('invitation', 'sent', '2026-10-31'),
      msg('chase_reply', 'sent', '2026-11-07', 1),
      msg('chase_reply', 'sent', '2026-11-14', 2),
    ];
    for (const day of ['2026-11-21', '2026-11-28', '2026-12-05']) {
      const d = decide(day, speaker('invited'), sent);
      expect(planned(d)).toEqual([]);
      expect(d.blocked).toHaveLength(1);
      expect(d.blocked[0]?.roundsSent).toBe(2);
    }
    // A limit of 3 lets the third through.
    expect(
      planned(decide('2026-11-21', speaker('invited'), sent, { ...POLICY, chaseMaxRounds: 3 })),
    ).toEqual(['chase_reply#3']);
  });

  it('CHASE_MIN_INTERVAL_DAYS: measured from the last SENT message, in calendar days', () => {
    const sent = [msg('invitation', 'sent', '2026-11-01')];
    const p = { ...POLICY, chaseMinIntervalDays: 10 };
    expect(planned(decide('2026-11-10', speaker('invited'), sent, p))).toEqual([]);
    expect(planned(decide('2026-11-11', speaker('invited'), sent, p))).toEqual(['chase_reply#1']);
  });

  it('a chase is never scheduled for a message that was never marked sent', () => {
    for (const status of ['draft', 'approved', 'rejected', 'superseded'] as const) {
      const d = decide('2026-12-01', speaker('invited'), [msg('invitation', status)]);
      expect(planned(d)).toEqual([]);
      expect(d.blocked).toEqual([]);
    }
  });

  it('MAX_DRAFTS_PER_RUN: a backlog is cut, oldest due first, and the rest deferred', () => {
    const speakers = Array.from({ length: 13 }, (_, i) =>
      speaker('idea', { id: String(i).padStart(24, '0') }),
    );
    const d = decideActions({
      now: at('2026-11-20'),
      eventDate: EVENT,
      speakers,
      messages: [],
      policy: POLICY,
    });
    expect(d.actions).toHaveLength(10);
    expect(d.deferred).toHaveLength(3);
    expect(d.notes.join(' ')).toMatch(/13 messages are due/);
    expect(
      decideActions({
        now: at('2026-11-20'),
        eventDate: EVENT,
        speakers,
        messages: [],
        policy: { ...POLICY, maxDraftsPerRun: 0 },
      }).actions,
    ).toEqual([]);
  });

  it('a rejected chase is final for that kind', () => {
    const d = decide('2026-11-30', speaker('confirmed'), [msg('chase_abstract', 'rejected')]);
    expect(planned(d)).toEqual([]);
    expect(d.waiting[0]?.why).toMatch(/rejected at review/);
  });

  it('the next round number follows the highest existing round, whatever its status', () => {
    const d = decide('2026-11-30', speaker('confirmed'), [
      msg('chase_abstract', 'superseded', undefined, 1),
      msg('chase_abstract', 'sent', '2026-11-20', 2),
    ]);
    expect(planned(d)).toEqual(['chase_abstract#3']);
  });

  it('refuses a nonsensical policy', () => {
    expect(() =>
      decide('2026-11-01', speaker('idea'), [], { ...POLICY, chaseMaxRounds: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      decide('2026-11-01', speaker('idea'), [], { ...POLICY, chaseMinIntervalDays: 0 }),
    ).toThrow(RangeError);
  });
});

describe('decideActions: the event', () => {
  it('no date: nothing scheduled, and says so', () => {
    const d = decideActions({
      now: at('2026-11-20'),
      eventDate: undefined,
      speakers: [speaker('idea')],
      messages: [],
      policy: POLICY,
    });
    expect(d.actions).toEqual([]);
    expect(d.notes[0]).toMatch(/no date/);
  });

  it('is pure: same input, same output, input untouched', () => {
    const messages = Object.freeze([Object.freeze(msg('invitation', 'sent', '2026-11-01'))]);
    const input = {
      now: at('2026-11-08'),
      eventDate: EVENT,
      speakers: [speaker('invited')],
      messages,
      policy: POLICY,
    };
    expect(decideActions(input)).toEqual(decideActions(input));
  });

  it('the event moving closer brings actions forward, and never repeats one already drafted', () => {
    const s = speaker('confirmed');
    const later = '2026-12-19T00:00:00.000Z';
    expect(
      decideActions({
        now: at('2026-11-14'),
        eventDate: later,
        speakers: [s],
        messages: [],
        policy: POLICY,
      }).actions,
    ).toEqual([]);
    const moved = decideActions({
      now: at('2026-11-14'),
      eventDate: EVENT,
      speakers: [s],
      messages: [],
      policy: POLICY,
    });
    expect(planned(moved)).toEqual(['chase_abstract#1']);
    const again = decideActions({
      now: at('2026-11-14'),
      eventDate: EVENT,
      speakers: [s],
      messages: [msg('chase_abstract', 'draft')],
      policy: POLICY,
    });
    expect(planned(again)).toEqual([]);
  });
});

describe('decideActions: every chase kind ends in a task (review findings)', () => {
  it('slides never arrive: one chase, then a task when no second chase fits before the event', () => {
    const sent = [msg('chase_slides', 'sent', '2026-12-05')];
    const s = speaker('abstract_received');
    // The next chase would be due 12 Dec, the event day. Until the window closes (T-4d, 8 Dec), wait.
    const waiting = decide('2026-12-08', s, sent);
    expect(planned(waiting)).toEqual([]);
    expect(waiting.blocked).toEqual([]);
    expect(waiting.waiting[0]).toMatchObject({ kind: 'chase_slides', dueOn: '2026-12-09' });
    for (const day of ['2026-12-09', '2026-12-11', '2026-12-12']) {
      const d = decide(day, s, sent);
      expect(planned(d)).toEqual([]);
      expect(d.blocked.map((b) => [b.kind, b.why, b.roundsSent])).toEqual([
        ['chase_slides', 'no_time', 1],
      ]);
    }
    expect(decide('2026-12-13', s, sent).blocked).toEqual([]);
  });

  it('a limit whose interval runs past the event still produces the task', () => {
    const sent = [
      msg('chase_bio', 'sent', '2026-11-30', 1),
      msg('chase_bio', 'sent', '2026-12-07', 2),
    ];
    const s = speaker('confirmed', { hasBio: false, hasPhoto: true });
    const d = decide('2026-12-09', s, [...sent, msg('chase_abstract', 'sent', '2026-11-14')]);
    expect(d.blocked.filter((b) => b.kind === 'chase_bio').map((b) => b.why)).toEqual(['no_time']);
  });

  it('every chase kind reaches a task for some timeline, at the default policy', () => {
    const cases: [SpeakerStatus, MessageKind, Partial<PipelineSpeaker>][] = [
      ['invited', 'chase_reply', {}],
      ['confirmed', 'chase_abstract', {}],
      ['confirmed', 'chase_bio', { hasBio: false }],
      ['confirmed', 'chase_photo', { hasPhoto: false }],
      ['abstract_received', 'chase_slides', {}],
    ];
    for (const [status, kind, over] of cases) {
      const extra = kind === 'chase_reply' ? [msg('invitation', 'sent', '2026-10-31')] : [];
      const d = decide('2026-12-10', speaker(status, over), extra);
      expect(
        d.blocked.map((b) => b.kind),
        kind,
      ).toContain(kind);
    }
  });

  it('on the event day an unsent pre-event draft is superseded; a thank-you is not', () => {
    const d = decide('2026-12-12', speaker('confirmed'), [msg('chase_abstract', 'approved')]);
    expect(d.supersede.map((x) => x.reason)).toEqual(['the event day has come']);
    const t = decide('2026-12-20', speaker('slides_received'), [msg('thank_you', 'approved')]);
    expect(t.supersede).toEqual([]);
  });

  it('a speaker reset to idea AFTER a sent invitation is re-approached, with a new round (finding 5)', () => {
    const sent = [msg('invitation', 'sent', '2026-11-01')];
    const reset = speaker('idea', { statusSince: '2026-11-10T08:00:00.000Z' });
    const d = decide('2026-11-20', reset, sent);
    expect(planned(d)).toEqual(['invitation#2']);
    // Reset BEFORE the invitation was sent: not a re-approach, still parked.
    const early = speaker('idea', { statusSince: '2026-10-20T08:00:00.000Z' });
    expect(planned(decide('2026-11-20', early, sent))).toEqual([]);
  });

  it('after a re-approach, reply chases count from the new invitation', () => {
    const msgs = [
      msg('invitation', 'sent', '2026-11-01', 1),
      msg('chase_reply', 'sent', '2026-11-08', 1),
      msg('chase_reply', 'sent', '2026-11-15', 2),
      msg('invitation', 'sent', '2026-11-20', 2),
    ];
    const d = decide('2026-11-27', speaker('invited'), msgs);
    expect(planned(d)).toEqual(['chase_reply#3']);
    expect(d.blocked).toEqual([]);
  });

  it('a parked speaker (invitation already sent) is shown as parked, not silently skipped', () => {
    const d = decide('2026-11-20', speaker('idea'), [msg('invitation', 'sent', '2026-11-01')]);
    expect(d.waiting.map((w) => w.why)).toEqual([
      'parked: the invitation for this event was already sent; nothing more is drafted for this event',
    ]);
  });
});

describe('blocked task titles', () => {
  const item = (why: 'limit' | 'no_time', roundsSent: number) => ({
    speakerId: S,
    kind: 'chase_slides' as const,
    roundsSent,
    why,
    reason: 'x',
  });
  it.each([
    ['limit', 2, 'Call W about the slides — 2 chases unanswered'],
    [
      'no_time',
      1,
      'Call W about the slides — 1 chase unanswered, too close to the event to chase again',
    ],
    ['no_time', 0, 'Call W about the slides — too close to the event to chase by email'],
  ] as const)('%s, %i sent', (why, n, title) => {
    expect(blockedTaskTitle('W', item(why, n))).toBe(title);
  });
});
