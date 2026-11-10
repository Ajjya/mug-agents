import type { PlanDraft } from '../../src/agents/planner/planner.graph.js';
import type { ChecklistOutput, TimelineOutput } from '../../src/agents/planner/llm-schemas.js';
import type { EventBrief } from '../../src/agents/planner/planner.state.js';
import { MILESTONE_KEYS, computeMilestones } from '../../src/agents/planner/timeline.js';

/** "Today" for every planner test, so milestone dates never drift. */
export const NOW = new Date('2026-11-10T10:00:00.000Z');

export const brief = (over: Partial<EventBrief> = {}): EventBrief => ({
  theme: 'Vector search in MongoDB',
  date: '2027-01-12T00:00:00.000Z', // 63 days after NOW: nothing clamped
  format: 'talks',
  capacity: 80,
  ...over,
});

export const timelineOutput = (): TimelineOutput => ({
  milestones: MILESTONE_KEYS.map((key) => ({
    key,
    goal: `Goal for ${key}`,
    work: [`Work for ${key}`],
  })),
});

export const checklistOutput = (): ChecklistOutput => ({
  tasks: [
    { milestone: 'T-8w', title: 'Confirm venue', owner: 'venue-lead' },
    { milestone: 'T-8w', title: 'Draft call for speakers', owner: 'speaker-liaison' },
    { milestone: 'T-4w', title: 'Publish the Meetup page', owner: 'marketing' },
    { milestone: 'day-of', title: 'Set up registration desk', owner: 'volunteer' },
    { milestone: 'T+3d', title: 'Send thank-you note', owner: 'organiser' },
  ],
});

export const draft = (b: EventBrief = brief(), over: Partial<PlanDraft> = {}): PlanDraft => ({
  brief: b,
  milestones: computeMilestones(b.date, NOW),
  timeline: timelineOutput(),
  checklist: checklistOutput(),
  calls: [],
  ...over,
});
