import { describe, expect, it } from 'vitest';
import { toStorage } from '../../src/domain/common.js';
import { TaskInputSchema } from '../../src/domain/task.schema.js';
import { EventInputSchema } from '../../src/domain/event.schema.js';
import {
  eventInputFromBrief,
  eventPatchFromBrief,
  mapChecklistToTasks,
  taskNaturalKey,
} from '../../src/agents/planner/mapping.js';
import { computeMilestones } from '../../src/agents/planner/timeline.js';
import { NOW, brief, checklistOutput } from '../support/planner-fixtures.js';

const EVENT_ID = 'a'.repeat(24);

describe('mapChecklistToTasks', () => {
  const milestones = computeMilestones(brief().date, NOW);
  const tasks = mapChecklistToTasks(checklistOutput(), milestones, EVENT_ID);

  it('produces valid TaskInputs with agent source, open status and the event link', () => {
    expect(tasks).toHaveLength(5);
    for (const t of tasks) {
      expect(() => toStorage(TaskInputSchema, t)).not.toThrow(); // valid domain input
      expect(t).toMatchObject({ source: 'agent', status: 'open', relatedEventId: EVENT_ID });
    }
  });

  it('takes the due date from the milestone, never from the model', () => {
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]));
    expect(byTitle['Confirm venue']).toMatchObject({
      milestoneKey: 'T-8w',
      dueAt: milestones[0]?.dateIso,
    });
    expect(byTitle['Send thank-you note']).toMatchObject({
      milestoneKey: 'T+3d',
      dueAt: milestones[8]?.dateIso,
    });
  });

  it('uses the clamped date for a milestone that was already past', () => {
    const rushed = computeMilestones('2026-11-20T00:00:00.000Z', NOW);
    const t = mapChecklistToTasks(checklistOutput(), rushed, EVENT_ID);
    expect(t.find((x) => x.milestoneKey === 'T-8w')?.dueAt).toBe('2026-11-10T00:00:00.000Z');
  });

  it('carries no id, version or timestamp fields', () => {
    for (const t of tasks) expect(Object.keys(t)).not.toEqual(expect.arrayContaining(['_id']));
  });
});

describe('event mapping', () => {
  it('builds a valid Event input in phase planning', () => {
    const e = eventInputFromBrief(brief({ coHost: 'Data Club', notes: 'n' }));
    expect(() => toStorage(EventInputSchema, e)).not.toThrow();
    expect(e).toMatchObject({
      phase: 'planning',
      title: brief().theme,
      capacity: 80,
      notes: 'n\nCo-host: Data Club',
    });
    expect('notes' in eventInputFromBrief(brief())).toBe(false);
  });

  it('patches phase only from idea', () => {
    expect(eventPatchFromBrief(brief(), 'idea').phase).toBe('planning');
    expect(eventPatchFromBrief(brief(), 'planning')).not.toHaveProperty('phase');
    expect(eventPatchFromBrief(brief(), 'published')).not.toHaveProperty('phase');
    expect(eventPatchFromBrief(brief(), 'done')).not.toHaveProperty('phase');
  });
});

describe('taskNaturalKey', () => {
  it('ignores case, surrounding and repeated whitespace; distinguishes milestone and event', () => {
    const k = taskNaturalKey(EVENT_ID, 'T-8w', 'Book venue');
    expect(taskNaturalKey(EVENT_ID.toUpperCase(), 'T-8w', '  book   VENUE ')).toBe(k);
    expect(taskNaturalKey(EVENT_ID, 'T-6w', 'Book venue')).not.toBe(k);
    expect(taskNaturalKey('b'.repeat(24), 'T-8w', 'Book venue')).not.toBe(k);
  });
});
