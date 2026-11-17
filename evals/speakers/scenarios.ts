import { MemorySaver } from '@langchain/langgraph';
import type { ChasePolicy } from '../../src/agents/speakers/decide.js';
import type { SpeakerStatus } from '../../src/domain/speaker.schema.js';
import {
  POLICY,
  type SpeakersHarness,
  buildSpeakersHarness,
  inMemorySpeakerRepos,
} from '../../test/support/speakers-harness.js';
import { day, seed } from '../../test/support/speakers-workflow-suite.js';

/**
 * Trajectory evals for the Speakers agent: which path the graph took over time, not what the text
 * said. Frozen clock, scripted model (real validation and ladder), in-memory storage and checkpointer.
 *
 * A path is one step per run: `MM-DD <what was drafted / tasked>`, `-` when nothing happened.
 * Human actions (approve, sent, status) happen between runs and are not steps.
 */

export interface ScenarioResult {
  name: string;
  expected: string[];
  actual: string[];
  pass: boolean;
  /** What the scenario checks beyond the path. */
  checks: { what: string; ok: boolean }[];
}

interface Ctx {
  h: SpeakersHarness;
  eventId: string;
  speakers: Record<string, string>;
  path: string[];
}

async function setup(
  people: { name: string; status: SpeakerStatus; contacted?: boolean }[],
  policy: ChasePolicy = POLICY,
  saver = new MemorySaver(),
): Promise<Ctx> {
  const h = buildSpeakersHarness(inMemorySpeakerRepos(), { saver, policy });
  const s = await seed(h.repos, people);
  return { h, eventId: s.eventId, speakers: s.speakers, path: [] };
}

/** One run on a given day; records what it produced as one path step. */
async function step(ctx: Ctx, date: string, opts: { approve?: boolean; sendAll?: boolean } = {}) {
  const before = (await ctx.h.repos.tasks.findByEventId(ctx.eventId)).items.length;
  const r = await ctx.h.service.run(ctx.eventId, { now: day(date) });
  const tasks = (await ctx.h.repos.tasks.findByEventId(ctx.eventId)).items;
  const items = [
    ...r.created.map((m) => `${m.kind}#${String(m.round)}`),
    ...tasks.slice(before).map((t) => `task:${t.milestoneKey?.replace('chase-limit:', '') ?? '?'}`),
  ];
  ctx.path.push(`${date.slice(5)} ${items.join(', ') || '-'}`);
  if (opts.approve && r.requestId) {
    await ctx.h.approvals.decide(r.requestId, { decision: 'approve' }, 'eval');
  }
  if (opts.sendAll) {
    for (const m of r.created) await ctx.h.service.sent(m._id, 'eval', day(date));
  }
  return r;
}

const result = (
  name: string,
  expected: string[],
  ctx: Ctx,
  checks: { what: string; ok: boolean }[] = [],
): ScenarioResult => ({
  name,
  expected,
  actual: ctx.path,
  pass: JSON.stringify(expected) === JSON.stringify(ctx.path) && checks.every((c) => c.ok),
  checks,
});

/** Event day Saturday 12 December 2026 (seed). T-6w 31 Oct, T-4w 14 Nov. */
export async function speakerNeverReplies(): Promise<ScenarioResult> {
  const ctx = await setup([{ name: 'Wendeline Gooseberry', status: 'idea' }]);
  await step(ctx, '2026-10-31', { approve: true, sendAll: true });
  await step(ctx, '2026-11-07', { sendAll: true });
  await step(ctx, '2026-11-14', { sendAll: true });
  await step(ctx, '2026-11-21', { sendAll: true });
  await step(ctx, '2026-11-28');
  const replies = (await ctx.h.repos.messages.findByEventId(ctx.eventId)).items.filter(
    (m) => m.kind === 'chase_reply',
  );
  return result(
    'Speaker never replies',
    [
      '10-31 invitation#1',
      '11-07 chase_reply#1',
      '11-14 chase_reply#2',
      '11-21 task:chase_reply',
      '11-28 -',
    ],
    ctx,
    [{ what: 'no third chase exists', ok: replies.length === 2 }],
  );
}

export async function speakerConfirmsLate(): Promise<ScenarioResult> {
  const ctx = await setup([{ name: 'Wendeline Gooseberry', status: 'idea' }]);
  const sp = ctx.speakers['Wendeline Gooseberry'] ?? '';
  await step(ctx, '2026-10-31', { approve: true, sendAll: true });
  await step(ctx, '2026-11-07', { sendAll: true });
  // The reply arrives after the first chase; the organiser records it.
  await ctx.h.service.setStatus(sp, ctx.eventId, 'confirmed', day('2026-11-10'));
  await step(ctx, '2026-11-14');
  await step(ctx, '2026-11-15');
  return result(
    'Speaker confirms late',
    ['10-31 invitation#1', '11-07 chase_reply#1', '11-14 chase_abstract#1', '11-15 -'],
    ctx,
  );
}

export async function speakerDeclines(): Promise<ScenarioResult> {
  const ctx = await setup([{ name: 'Wendeline Gooseberry', status: 'idea' }]);
  const sp = ctx.speakers['Wendeline Gooseberry'] ?? '';
  await step(ctx, '2026-10-31', { approve: true, sendAll: true });
  await step(ctx, '2026-11-07'); // chase drafted, not sent
  await ctx.h.service.setStatus(sp, ctx.eventId, 'declined', day('2026-11-08'));
  await step(ctx, '2026-11-14');
  await step(ctx, '2026-11-21');
  await step(ctx, '2026-12-13');
  const pending = (await ctx.h.repos.messages.findByEventId(ctx.eventId)).items.filter(
    (m) => m.status === 'draft' || m.status === 'approved',
  );
  return result(
    'Speaker declines',
    ['10-31 invitation#1', '11-07 chase_reply#1', '11-14 -', '11-21 -', '12-13 -'],
    ctx,
    [{ what: 'the unsent chase is superseded, nothing left to send', ok: pending.length === 0 }],
  );
}

export async function eventMovesCloser(): Promise<ScenarioResult> {
  const ctx = await setup([{ name: 'Wendeline Gooseberry', status: 'confirmed', contacted: true }]);
  // Push the event a week later first: T-4w is then 21 Nov.
  await ctx.h.repos.events.updateWithRetry(ctx.eventId, () => ({
    date: '2026-12-19T00:00:00.000Z',
  }));
  await step(ctx, '2026-11-14');
  // The date moves back to 12 Dec: T-4w is now 14 Nov, today.
  await ctx.h.repos.events.updateWithRetry(ctx.eventId, () => ({
    date: '2026-12-12T00:00:00.000Z',
  }));
  await step(ctx, '2026-11-14');
  await step(ctx, '2026-11-14');
  await step(ctx, '2026-11-17');
  return result(
    'Event date moves closer',
    ['11-14 -', '11-14 chase_abstract#1', '11-14 -', '11-17 -'],
    ctx,
  );
}

export async function clockJumpsAMonth(): Promise<ScenarioResult> {
  const people = Array.from({ length: 13 }, (_, i) => ({
    name: `Speaker ${String.fromCharCode(65 + i)}`,
    status: 'confirmed' as const,
    contacted: true,
  }));
  const ctx = await setup(people);
  // Nobody ran the agent for a month: at T-3w everyone is due an abstract chase at once.
  const r = await step(ctx, '2026-11-21');
  const n = r.created.length;
  ctx.path[0] = `11-21 ${String(n)} drafts`;
  const second = await step(ctx, '2026-11-21');
  ctx.path[1] = `11-21 ${String(second.created.length)} drafts`;
  return result(
    'Clock jumps forward a month',
    [`11-21 ${String(POLICY.maxDraftsPerRun)} drafts`, '11-21 3 drafts'],
    ctx,
    [
      {
        what: `never more than MAX_DRAFTS_PER_RUN (${String(POLICY.maxDraftsPerRun)})`,
        ok: n <= POLICY.maxDraftsPerRun,
      },
    ],
  );
}

export async function resumeMidApproval(): Promise<ScenarioResult> {
  const saver = new MemorySaver();
  const ctx = await setup([{ name: 'Wendeline Gooseberry', status: 'idea' }], POLICY, saver);
  const r = await step(ctx, '2026-10-31');
  // A different runtime on the same checkpointer and storage: the "next process".
  const next = buildSpeakersHarness(ctx.h.repos, { saver });
  const calls = ctx.h.model.prompts.length + next.model.prompts.length;
  const decided = await next.approvals.decide(r.requestId ?? '', { decision: 'approve' }, 'eval');
  const msgs = (await ctx.h.repos.messages.findByEventId(ctx.eventId)).items;
  ctx.path.push(`10-31 resumed: ${decided.thread.status}`);
  return result('Resume mid-approval', ['10-31 invitation#1', '10-31 resumed: completed'], ctx, [
    { what: 'one draft, approved', ok: msgs.length === 1 && msgs[0]?.status === 'approved' },
    {
      what: 'no model call on resume',
      ok: ctx.h.model.prompts.length + next.model.prompts.length === calls,
    },
  ]);
}

/** Review: the eval only ever took chase_reply to its limit. Slides start T-1w, so the window is short. */
export async function slidesNeverArrive(): Promise<ScenarioResult> {
  const ctx = await setup([
    { name: 'Wendeline Gooseberry', status: 'abstract_received', contacted: true },
  ]);
  await step(ctx, '2026-12-05', { sendAll: true });
  await step(ctx, '2026-12-08');
  await step(ctx, '2026-12-09');
  await step(ctx, '2026-12-12');
  await step(ctx, '2026-12-13');
  const slides = (await ctx.h.repos.messages.findByEventId(ctx.eventId)).items.filter(
    (m) => m.kind === 'chase_slides',
  );
  return result(
    'Slides never arrive',
    ['12-05 chase_slides#1', '12-08 -', '12-09 task:chase_slides', '12-12 -', '12-13 -'],
    ctx,
    [{ what: 'one slides chase, then a task (no second chase fits)', ok: slides.length === 1 }],
  );
}

/** Several speakers at different stages through the whole timeline, every message kind once. */
export async function fullPipeline(): Promise<ScenarioResult> {
  const ctx = await setup([
    { name: 'Ada One', status: 'idea', contacted: true },
    { name: 'Bea Two', status: 'confirmed', contacted: true },
    { name: 'Cy Three', status: 'abstract_received', contacted: true },
    { name: 'Di Four', status: 'slides_received', contacted: true },
  ]);
  await step(ctx, '2026-10-31', { sendAll: true }); // invitation to Ada
  await step(ctx, '2026-11-14', { sendAll: true }); // abstract chase to Bea
  await step(ctx, '2026-12-05', { sendAll: true }); // slides chase to Cy
  await step(ctx, '2026-12-13', { sendAll: true }); // thank-you to Di
  await step(ctx, '2026-12-14');
  const tasks = (await ctx.h.repos.tasks.findByEventId(ctx.eventId)).items;
  return result(
    'Full pipeline, four speakers',
    [
      '10-31 invitation#1',
      // Ada's invitation went out 10-31 (14 days ago, so a reply chase); Bea is at T-4w.
      '11-14 chase_reply#1, chase_abstract#1',
      // 21 days on: both are chased a second time; Cy is at T-1w for slides.
      '12-05 chase_reply#2, chase_abstract#2, chase_slides#1',
      '12-13 thank_you#1',
      // The event is over: no more chases and no tasks.
      '12-14 -',
    ],
    ctx,
    [{ what: 'no task: nobody is stuck', ok: tasks.length === 0 }],
  );
}

export const SCENARIOS = [
  speakerNeverReplies,
  speakerConfirmsLate,
  speakerDeclines,
  eventMovesCloser,
  clockJumpsAMonth,
  resumeMidApproval,
  slidesNeverArrive,
  fullPipeline,
];

export async function runScenarios(): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of SCENARIOS) out.push(await s());
  return out;
}

export function reportTable(results: readonly ScenarioResult[]): string {
  const cell = (xs: readonly string[]) => xs.join(' → ').replace(/\|/g, '\\|');
  const lines = [
    '| Scenario | Expected path | Actual path | Also checked | Result |',
    '|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.name} | ${cell(r.expected)} | ${cell(r.actual)} | ${r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.what}`).join('; ') || '-'} | ${r.pass ? 'pass' : 'FAIL'} |`,
    ),
  ];
  return lines.join('\n');
}
