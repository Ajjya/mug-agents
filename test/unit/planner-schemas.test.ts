import { describe, expect, it } from 'vitest';
import {
  ChecklistOutputSchema,
  TimelineOutputSchema,
} from '../../src/agents/planner/llm-schemas.js';
import { EventBriefSchema, PlannerStateSchema } from '../../src/agents/planner/planner.state.js';
import { MILESTONE_KEYS } from '../../src/agents/planner/timeline.js';
import { checklistOutput, timelineOutput } from '../support/planner-fixtures.js';

describe('EventBriefSchema', () => {
  const ok = { theme: ' Atlas Search ', date: '2027-02-01', format: 'workshop', capacity: 40 };

  it('accepts a minimal brief, trims, and normalises a date-only value to UTC midnight', () => {
    expect(EventBriefSchema.parse(ok)).toEqual({
      theme: 'Atlas Search',
      date: '2027-02-01T00:00:00.000Z',
      format: 'workshop',
      capacity: 40,
    });
  });

  it('accepts optional coHost, notes, eventId and a full ISO datetime', () => {
    const b = EventBriefSchema.parse({
      ...ok,
      date: '2027-02-01T18:30:00+01:00',
      coHost: 'Data Club',
      notes: 'hello',
      eventId: 'a'.repeat(24),
    });
    expect(b.date).toBe('2027-02-01T17:30:00.000Z');
    expect(b.coHost).toBe('Data Club');
  });

  it.each([
    ['empty theme', { theme: '  ' }],
    ['bad date', { date: '01/02/2027' }],
    ['impossible date', { date: '2027-13-45' }],
    ['unknown format', { format: 'party' }],
    ['zero capacity', { capacity: 0 }],
    ['fractional capacity', { capacity: 10.5 }],
    ['bad eventId', { eventId: 'xyz' }],
    ['unknown key', { surprise: 1 }],
  ])('rejects %s', (_n, over) => {
    expect(EventBriefSchema.safeParse({ ...ok, ...over }).success).toBe(false);
  });
});

describe('LLM output schemas', () => {
  it('accept well-formed output', () => {
    expect(TimelineOutputSchema.safeParse(timelineOutput()).success).toBe(true);
    expect(ChecklistOutputSchema.safeParse(checklistOutput()).success).toBe(true);
  });

  it('contain no _id, version, timestamp or date fields', () => {
    const text = JSON.stringify([
      TimelineOutputSchema.shape.milestones,
      ChecklistOutputSchema.shape.tasks,
    ]);
    expect(text).not.toMatch(/_id|version|createdAt|updatedAt|dueAt|dateIso/);
  });

  it('reject any invented id or extra key, at any level', () => {
    const t = timelineOutput();
    expect(TimelineOutputSchema.safeParse({ ...t, id: '507f1f77bcf86cd799439011' }).success).toBe(
      false,
    );
    const withId = { milestones: t.milestones.map((m, i) => (i === 0 ? { ...m, _id: 'x' } : m)) };
    expect(TimelineOutputSchema.safeParse(withId).success).toBe(false);
    const c = checklistOutput();
    const bad = { tasks: c.tasks.map((x, i) => (i === 0 ? { ...x, id: '1' } : x)) };
    expect(ChecklistOutputSchema.safeParse(bad).success).toBe(false);
    const dated = { tasks: c.tasks.map((x, i) => (i === 0 ? { ...x, dueAt: '2027-01-01' } : x)) };
    expect(ChecklistOutputSchema.safeParse(dated).success).toBe(false);
  });

  it('timeline must have every milestone once, in order (no invented key)', () => {
    const t = timelineOutput();
    expect(TimelineOutputSchema.safeParse({ milestones: t.milestones.slice(1) }).success).toBe(
      false,
    );
    expect(
      TimelineOutputSchema.safeParse({ milestones: [...t.milestones].reverse() }).success,
    ).toBe(false);
    const invented = {
      milestones: t.milestones.map((m, i) => (i === 0 ? { ...m, key: 'T-9w' } : m)),
    };
    expect(TimelineOutputSchema.safeParse(invented).success).toBe(false);
    const dup = { milestones: [...t.milestones, t.milestones[0]] };
    expect(TimelineOutputSchema.safeParse(dup).success).toBe(false);
  });

  it('checklist rejects unknown milestone, unknown owner, empty title, empty list and duplicate titles', () => {
    const base = checklistOutput().tasks[0];
    if (!base) throw new Error('fixture');
    const parse = (tasks: unknown[]) => ChecklistOutputSchema.safeParse({ tasks }).success;
    expect(parse([{ ...base, milestone: 'T-9w' }])).toBe(false);
    expect(parse([{ ...base, owner: 'alice' }])).toBe(false);
    expect(parse([{ ...base, title: '  ' }])).toBe(false);
    expect(parse([])).toBe(false);
    expect(parse([base, { ...base, title: base.title.toUpperCase() }])).toBe(false);
    expect(parse([base, { ...base, milestone: 'T-1w' }])).toBe(true);
  });

  it('milestone keys in the schema match the timeline module', () => {
    expect(MILESTONE_KEYS).toHaveLength(9);
  });
});

describe('PlannerStateSchema', () => {
  it('defaults calls to an empty array', () => {
    expect(PlannerStateSchema.parse({}).calls).toEqual([]);
  });
});
