import { beforeEach, describe, expect, it } from 'vitest';
import type { EventBrief } from '../../src/agents/planner/planner.state.js';
import type { PlanDraft, PlannerGraph } from '../../src/agents/planner/planner.graph.js';
import {
  EventNotFoundError,
  InvalidBriefError,
  PlannerService,
} from '../../src/agents/planner/planner.service.js';
import { PastEventDateError } from '../../src/agents/planner/timeline.js';
import type { EventsRepository } from '../../src/repositories/events.repository.js';
import type { TasksRepository } from '../../src/repositories/tasks.repository.js';
import { NOW, brief, draft } from './planner-fixtures.js';

export interface Repos {
  events: EventsRepository;
  tasks: TasksRepository;
}

class StubGraph implements PlannerGraph {
  runs = 0;
  constructor(public next: () => PlanDraft | Promise<PlanDraft>) {}
  /** Like the real graph, the draft carries the brief it was given. */
  async run(brief: EventBrief): Promise<PlanDraft> {
    this.runs++;
    return { ...(await this.next()), brief };
  }
}

/** One suite, two backends: in-memory fakes (unit) and real MongoDB (integration). */
export function plannerServiceSuite(create: () => Promise<Repos>): void {
  describe('PlannerService (persistence, stubbed graph)', () => {
    let repos: Repos;
    let graph: StubGraph;
    let service: PlannerService;

    beforeEach(async () => {
      repos = await create();
      graph = new StubGraph(() => draft());
      service = new PlannerService(graph, repos.events, repos.tasks);
    });

    it('creates the event (phase planning) and the tasks, linked and dated in code', async () => {
      const r = await service.plan(brief({ coHost: 'Lisbon Data Club', notes: 'Bring stickers' }), {
        now: NOW,
      });
      expect(r.eventCreated).toBe(true);
      expect(r.event).toMatchObject({
        title: 'Vector search in MongoDB',
        theme: 'Vector search in MongoDB',
        phase: 'planning',
        date: '2027-01-12T00:00:00.000Z',
        capacity: 80,
        notes: 'Bring stickers\nCo-host: Lisbon Data Club',
      });
      expect(r.created).toHaveLength(5);
      expect(r.skipped).toBe(0);

      const stored = (await repos.tasks.findByEventId(r.event._id)).items;
      expect(stored).toHaveLength(5);
      for (const t of stored) {
        expect(t).toMatchObject({ source: 'agent', status: 'open', relatedEventId: r.event._id });
      }
      const byTitle = Object.fromEntries(stored.map((t) => [t.title, t]));
      expect(byTitle['Confirm venue']).toMatchObject({
        milestoneKey: 'T-8w',
        owner: 'venue-lead',
        dueAt: '2026-11-17T00:00:00.000Z', // 2027-01-12 minus 56 days
      });
      expect(byTitle['Send thank-you note']?.dueAt).toBe('2027-01-15T00:00:00.000Z'); // event + 3 days
      expect(byTitle['Set up registration desk']?.dueAt).toBe('2027-01-12T00:00:00.000Z');
    });

    it('is idempotent: running again on the same brief creates nothing and matches the event', async () => {
      const first = await service.plan(brief(), { now: NOW });
      const second = await service.plan(brief(), { now: NOW });
      expect(second.eventCreated).toBe(false);
      expect(second.event._id).toBe(first.event._id);
      expect(second.created).toHaveLength(0);
      expect(second.skipped).toBe(5);
      expect(await repos.tasks.count()).toBe(5);
      expect(await repos.events.count()).toBe(1);
    });

    it('treats case and whitespace differences in a title as the same task', async () => {
      await service.plan(brief(), { now: NOW });
      const d = draft();
      graph.next = () => ({
        ...d,
        checklist: {
          tasks: [{ milestone: 'T-8w', title: '  CONFIRM   venue ', owner: 'venue-lead' }],
        },
      });
      const r = await service.plan(brief(), { now: NOW });
      expect(r.created).toHaveLength(0);
      expect(await repos.tasks.count()).toBe(5);
    });

    it('adds only what is missing and never removes or edits existing tasks', async () => {
      const first = await service.plan(brief(), { now: NOW });
      const edited = first.created[0];
      if (!edited) throw new Error('expected a task');
      await repos.tasks.updateById(edited._id, { status: 'done' }, edited.version);

      const d = draft();
      graph.next = () => ({
        ...d,
        checklist: {
          tasks: [
            ...d.checklist.tasks,
            { milestone: 'T-2w', title: 'Order pizza', owner: 'volunteer' as const },
          ],
        },
      });
      const r = await service.plan(brief(), { now: NOW });
      expect(r.created.map((t) => t.title)).toEqual(['Order pizza']);
      expect(await repos.tasks.count()).toBe(6);
      expect((await repos.tasks.findById(edited._id))?.status).toBe('done');
    });

    it('same title in a different milestone is a different task', async () => {
      const d = draft();
      graph.next = () => ({
        ...d,
        checklist: {
          tasks: [
            { milestone: 'T-8w', title: 'Send reminder', owner: 'marketing' },
            { milestone: 'T-1w', title: 'Send reminder', owner: 'marketing' },
          ],
        },
      });
      const r = await service.plan(brief(), { now: NOW });
      expect(r.created).toHaveLength(2);
    });

    it('does not duplicate within a single checklist either', async () => {
      const d = draft();
      graph.next = () => ({
        ...d,
        checklist: {
          tasks: [
            { milestone: 'T-8w', title: 'Same', owner: 'marketing' },
            { milestone: 'T-8w', title: 'same', owner: 'marketing' },
          ],
        },
      });
      const r = await service.plan(brief(), { now: NOW });
      expect(r.created).toHaveLength(1);
      expect(r.skipped).toBe(1);
    });

    it('a different theme on the same day is a different event', async () => {
      await service.plan(brief(), { now: NOW });
      const other = await service.plan(brief({ theme: 'Atlas for beginners' }), { now: NOW });
      expect(other.eventCreated).toBe(true);
      expect(await repos.events.count()).toBe(2);
    });

    it('updates a matched event but never moves a later phase back to planning', async () => {
      const first = await service.plan(brief(), { now: NOW });
      await repos.events.updateById(first.event._id, { phase: 'published' }, first.event.version);
      const again = await service.plan(brief({ capacity: 120 }), { now: NOW });
      expect(again.event).toMatchObject({ phase: 'published', capacity: 120 });
    });

    it('brief.eventId plans an existing event; an unknown id is an error', async () => {
      const existing = await repos.events.insert({
        title: 'Placeholder',
        phase: 'idea',
        coHostOrganisationIds: [],
        agenda: [],
      });
      const r = await service.plan(brief({ eventId: existing._id }), { now: NOW });
      expect(r.event._id).toBe(existing._id);
      expect(r.event).toMatchObject({ phase: 'planning', theme: 'Vector search in MongoDB' });
      expect(r.created).toHaveLength(5);

      await expect(
        service.plan(brief({ eventId: 'c'.repeat(24) }), { now: NOW }),
      ).rejects.toBeInstanceOf(EventNotFoundError);
    });

    it('rejects a past date before the model runs and writes nothing', async () => {
      await expect(
        service.plan(brief({ date: '2026-11-09T00:00:00.000Z' }), { now: NOW }),
      ).rejects.toBeInstanceOf(PastEventDateError);
      expect(graph.runs).toBe(0);
      expect(await repos.events.count()).toBe(0);
    });

    it('rejects an invalid brief with every problem listed, before the model runs', async () => {
      const err = await service
        .plan({ theme: '', date: 'soon', format: 'party', capacity: 0 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidBriefError);
      const msg = (err as InvalidBriefError).message;
      for (const f of ['theme', 'date', 'format', 'capacity']) expect(msg).toContain(f);
      expect(graph.runs).toBe(0);
    });

    it('persists nothing when the graph fails', async () => {
      graph.next = () => Promise.reject(new Error('provider down'));
      await expect(service.plan(brief(), { now: NOW })).rejects.toThrow('provider down');
      expect(await repos.events.count()).toBe(0);
      expect(await repos.tasks.count()).toBe(0);
    });
  });
}
