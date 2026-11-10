import { z } from 'zod';
import { ChecklistOutputSchema, TimelineOutputSchema } from '../src/agents/planner/llm-schemas.js';
import { mapChecklistToTasks, taskNaturalKey } from '../src/agents/planner/mapping.js';
import type { PlanDraft } from '../src/agents/planner/planner.graph.js';
import { MILESTONE_KEYS } from '../src/agents/planner/timeline.js';

export interface AssertionResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const EVAL_EVENT_ID = 'e'.repeat(24);

/**
 * The deterministic checks every plan must pass (spec section 10). Pure: no model, no I/O.
 * The idempotency checks need persistence and live in `idempotency.ts`.
 */
export function assertDraft(draft: PlanDraft): AssertionResult[] {
  const results: AssertionResult[] = [];
  const check = (name: string, pass: boolean, detail?: string): void => {
    results.push({ name, pass, ...(detail === undefined || pass ? {} : { detail }) });
  };

  // 1. Output validates against the schemas (re-checked here, independently of the call layer).
  const timeline = TimelineOutputSchema.safeParse(draft.timeline);
  const checklist = ChecklistOutputSchema.safeParse(draft.checklist);
  check(
    'schemas-valid',
    timeline.success && checklist.success,
    [timeline, checklist]
      .map((r) => (r.success ? '' : z.prettifyError(r.error)))
      .join(' ')
      .trim(),
  );

  // 2. Every required milestone is present and in chronological order.
  const keys = draft.timeline.milestones.map((m) => m.key);
  check(
    'milestones-complete-and-ordered',
    keys.length === MILESTONE_KEYS.length && keys.every((k, i) => k === MILESTONE_KEYS[i]),
    `got ${keys.join(',')}`,
  );
  const times = draft.milestones.map((m) => new Date(m.dateIso).getTime());
  check(
    'milestone-dates-chronological',
    times.every((t, i) => i === 0 || t >= (times[i - 1] ?? 0)),
  );

  // 3. Every checklist item maps to a known milestone and has an owner.
  const known = new Set<string>(draft.milestones.map((m) => m.key));
  const orphans = draft.checklist.tasks.filter(
    (t) => !known.has(t.milestone) || t.owner.trim() === '',
  );
  check(
    'items-have-milestone-and-owner',
    orphans.length === 0,
    `${String(orphans.length)} item(s) without a known milestone or owner`,
  );

  // 4. Every dueAt is on or before the event date, except the T+3d follow-up.
  const eventTime = new Date(draft.brief.date).getTime();
  const tasks = mapChecklistToTasks(draft.checklist, draft.milestones, EVAL_EVENT_ID);
  const late = tasks.filter(
    (t) =>
      t.milestoneKey !== 'T+3d' && t.dueAt !== undefined && new Date(t.dueAt).getTime() > eventTime,
  );
  check(
    'due-dates-not-after-event',
    late.length === 0,
    `${String(late.length)} task(s) due after the event`,
  );

  // 5. No duplicate titles within a milestone.
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const t of tasks) {
    const k = taskNaturalKey(EVAL_EVENT_ID, t.milestoneKey, t.title);
    if (seen.has(k)) dups.push(`${t.milestoneKey ?? '?'}: ${t.title}`);
    seen.add(k);
  }
  check('no-duplicate-titles-per-milestone', dups.length === 0, dups.join('; '));

  return results;
}

export const firstFailure = (results: readonly AssertionResult[]): AssertionResult | undefined =>
  results.find((r) => !r.pass);
