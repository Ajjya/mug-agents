import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InvalidIdError, type EntityId } from '../../src/domain/common.js';
import type { Event, EventInput, EventPatch } from '../../src/domain/event.schema.js';
import type {
  Organisation,
  OrganisationInput,
  OrganisationPatch,
} from '../../src/domain/organisation.schema.js';
import type { Speaker, SpeakerInput, SpeakerPatch } from '../../src/domain/speaker.schema.js';
import type { Task, TaskInput, TaskPatch } from '../../src/domain/task.schema.js';
import {
  DuplicateKeyError,
  InvalidPatchError,
  VersionConflictError,
  type Repository,
} from '../../src/repositories/base.repository.js';
import type { EventsRepository } from '../../src/repositories/events.repository.js';
import type { OrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import type { SpeakersRepository } from '../../src/repositories/speakers.repository.js';
import type { TasksRepository } from '../../src/repositories/tasks.repository.js';
import { ID_A, ID_B, eventInput, organisationInput, speakerInput, taskInput } from './fixtures.js';

type Base = { _id: EntityId; version: number; createdAt: string; updatedAt: string };
type Factory<R> = () => R | Promise<R>;

interface Case<I, D extends Base, P, R extends Repository<I, D, P>> {
  create: Factory<R>;
  input(n: number): I;
  patch: P;
  /** Field that `patch` changes, and its expected new value. */
  patched: [keyof D, unknown];
  unknownFieldInput: unknown;
  invalidPatch: unknown;
}

/**
 * Behaviour every implementation of the repository contract must have. Run against the Mongo
 * repositories (integration) and the in-memory fakes (unit).
 */
function baseContract<I, D extends Base, P, R extends Repository<I, D, P>>(
  c: Case<I, D, P, R>,
): void {
  let repo: R;
  beforeEach(async () => {
    repo = await c.create();
  });

  it('insert: sets _id, version 1 and equal timestamps', async () => {
    const doc = await repo.insert(c.input(1));
    expect(doc._id).toMatch(/^[0-9a-f]{24}$/);
    expect(doc.version).toBe(1);
    expect(doc.createdAt).toBe(doc.updatedAt);
    expect(() => new Date(doc.createdAt).toISOString()).not.toThrow();
  });

  it('insert: rejects unknown fields and caller-supplied timestamps', async () => {
    await expect(repo.insert(c.unknownFieldInput as I)).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      repo.insert({ ...c.input(1), createdAt: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(await repo.count()).toBe(0);
  });

  it('findById: returns the document, or null when missing', async () => {
    const doc = await repo.insert(c.input(1));
    expect(await repo.findById(doc._id)).toEqual(doc);
    expect(await repo.findById('f'.repeat(24))).toBeNull();
  });

  it('count: counts all documents', async () => {
    expect(await repo.count()).toBe(0);
    await repo.insert(c.input(1));
    await repo.insert(c.input(2));
    expect(await repo.count()).toBe(2);
  });

  it('findMany: keyset-paginates in both directions', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await repo.insert(c.input(i)))._id);

    const seen: string[] = [];
    let after: EntityId | undefined;
    let pages = 0;
    do {
      const page = await repo.findMany({ limit: 2, ...(after ? { after } : {}) });
      seen.push(...page.items.map((d) => d._id));
      after = page.nextCursor;
      pages++;
    } while (after);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);

    const desc = await repo.findMany({ limit: 2, sort: 'desc' });
    expect(desc.items.map((d) => d._id)).toEqual([ids[4], ids[3]]);
    const desc2 = await repo.findMany({
      limit: 10,
      sort: 'desc',
      after: desc.nextCursor as string,
    });
    expect(desc2.items.map((d) => d._id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(desc2.nextCursor).toBeUndefined();
  });

  it('findMany: clamps the limit to at least 1 and rejects a malformed cursor', async () => {
    await repo.insert(c.input(1));
    await repo.insert(c.input(2));
    const page = await repo.findMany({ limit: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    await expect(repo.findMany({ after: 'garbage' })).rejects.toThrow();
  });

  it('updateById: applies the patch, bumps version and updatedAt, keeps createdAt', async () => {
    const doc = await repo.insert(c.input(1));
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.updateById(doc._id, c.patch, doc.version);
    expect(updated?.[c.patched[0]]).toEqual(c.patched[1]);
    expect(updated?.version).toBe(2);
    expect(updated?.createdAt).toBe(doc.createdAt);
    expect(new Date(updated?.updatedAt ?? 0).getTime()).toBeGreaterThan(
      new Date(doc.updatedAt).getTime(),
    );
    expect(await repo.findById(doc._id)).toEqual(updated);
  });

  it('optimistic locking: a stale version throws VersionConflictError and changes nothing', async () => {
    const doc = await repo.insert(c.input(1));
    const winner = await repo.updateById(doc._id, c.patch, doc.version);
    await expect(repo.updateById(doc._id, c.patch, doc.version)).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    expect(await repo.findById(doc._id)).toEqual(winner);
  });

  it('optimistic locking: of two concurrent updates from the same version exactly one wins', async () => {
    const doc = await repo.insert(c.input(1));
    const results = await Promise.allSettled([
      repo.updateById(doc._id, c.patch, doc.version),
      repo.updateById(doc._id, c.patch, doc.version),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost?.reason).toBeInstanceOf(VersionConflictError);
    expect((await repo.findById(doc._id))?.version).toBe(2);
  });

  describe('updateWithRetry', () => {
    it('applies mutate to the current document and returns the updated one', async () => {
      const doc = await repo.insert(c.input(1));
      const seen: number[] = [];
      const updated = await repo.updateWithRetry(doc._id, (d) => {
        seen.push(d.version);
        return c.patch;
      });
      expect(seen).toEqual([1]);
      expect(updated?.version).toBe(2);
      expect(updated?.[c.patched[0]]).toEqual(c.patched[1]);
    });

    it('re-reads and retries when another writer got in between', async () => {
      const doc = await repo.insert(c.input(1));
      const seen: number[] = [];
      const updated = await repo.updateWithRetry(doc._id, async (d) => {
        seen.push(d.version);
        // A competing writer wins the first attempt.
        if (seen.length === 1) await repo.updateById(doc._id, c.patch, d.version);
        return c.patch;
      });
      expect(seen).toEqual([1, 2]); // second attempt saw the fresh version
      expect(updated?.version).toBe(3);
    });

    it('rethrows VersionConflictError once the attempts are exhausted', async () => {
      const doc = await repo.insert(c.input(1));
      let calls = 0;
      await expect(
        repo.updateWithRetry(
          doc._id,
          async (d) => {
            calls++;
            await repo.updateById(doc._id, c.patch, d.version); // always lose the race
            return c.patch;
          },
          { attempts: 2 },
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(calls).toBe(2);
    });

    it('two concurrent read-modify-writes both land (version 3), none is lost', async () => {
      const doc = await repo.insert(c.input(1));
      const results = await Promise.all([
        repo.updateWithRetry(doc._id, () => c.patch),
        repo.updateWithRetry(doc._id, () => c.patch),
      ]);
      expect(results.every((r) => r !== null)).toBe(true);
      expect((await repo.findById(doc._id))?.version).toBe(3);
    });

    it('returns null without calling mutate for a missing or malformed id', async () => {
      let calls = 0;
      const mutate = () => {
        calls++;
        return c.patch;
      };
      expect(await repo.updateWithRetry('f'.repeat(24), mutate)).toBeNull();
      expect(await repo.updateWithRetry('abc', mutate)).toBeNull();
      expect(calls).toBe(0);
    });

    it('does not retry other errors (invalid patch) and rejects bad attempts', async () => {
      const doc = await repo.insert(c.input(1));
      let calls = 0;
      await expect(
        repo.updateWithRetry(doc._id, () => {
          calls++;
          return c.invalidPatch as P;
        }),
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(calls).toBe(1);
      await expect(
        repo.updateWithRetry(doc._id, () => c.patch, { attempts: 0 }),
      ).rejects.toBeInstanceOf(RangeError);
    });
  });

  it('updateById: null for a missing or malformed id; rejects invalid and empty patches', async () => {
    expect(await repo.updateById('f'.repeat(24), c.patch, 1)).toBeNull();
    expect(await repo.updateById('abc', c.patch, 1)).toBeNull();
    expect(await repo.findById('abc')).toBeNull();
    const doc = await repo.insert(c.input(1));
    await expect(repo.updateById(doc._id, c.invalidPatch as P, doc.version)).rejects.toBeInstanceOf(
      z.ZodError,
    );
    await expect(repo.updateById(doc._id, {} as P, doc.version)).rejects.toBeInstanceOf(
      InvalidPatchError,
    );
    expect(await repo.findById(doc._id)).toEqual(doc);
  });
}

/** Exported so the Mongo repository can assert its specific error type for bad cursors. */
export { InvalidIdError };

export function eventsContract(create: Factory<EventsRepository>): void {
  describe('events repository contract', () => {
    baseContract<EventInput, Event, EventPatch, EventsRepository>({
      create,
      input: (n) => eventInput({ title: `Event ${String(n)}` }),
      patch: { phase: 'planning' },
      patched: ['phase', 'planning'],
      unknownFieldInput: { ...eventInput(), surprise: 1 },
      invalidPatch: { phase: 'nope' },
    });

    describe('finders', () => {
      let repo: EventsRepository;
      beforeEach(async () => {
        repo = await create();
      });

      it('findByPhase: filters by phase and paginates', async () => {
        await repo.insert(eventInput({ title: 'a', phase: 'idea' }));
        await repo.insert(eventInput({ title: 'b', phase: 'planning' }));
        await repo.insert(eventInput({ title: 'c', phase: 'planning' }));
        const all = await repo.findByPhase('planning');
        expect(all.items.map((e) => e.title)).toEqual(['b', 'c']);
        const first = await repo.findByPhase('planning', { limit: 1 });
        expect(first.items.map((e) => e.title)).toEqual(['b']);
        const second = await repo.findByPhase('planning', {
          limit: 1,
          after: first.nextCursor as string,
        });
        expect(second.items.map((e) => e.title)).toEqual(['c']);
        expect((await repo.findByPhase('done')).items).toEqual([]);
      });

      it('findByPhase: rejects a value that is not a phase (no operator smuggling)', async () => {
        await expect(repo.findByPhase({ $ne: 'x' } as never)).rejects.toBeInstanceOf(z.ZodError);
      });

      it('findByDateRange: half-open [from, to), ignores events without a date', async () => {
        await repo.insert(eventInput({ title: 'jan', date: '2026-01-10T18:00:00Z' }));
        await repo.insert(eventInput({ title: 'feb', date: '2026-02-10T18:00:00Z' }));
        await repo.insert(eventInput({ title: 'mar', date: '2026-03-10T18:00:00Z' }));
        await repo.insert(eventInput({ title: 'undated' }));
        const r = await repo.findByDateRange('2026-01-10T18:00:00Z', '2026-03-10T18:00:00Z');
        expect(r.items.map((e) => e.title)).toEqual(['jan', 'feb']);
      });

      it('findByDateRange: rejects invalid dates', async () => {
        await expect(
          repo.findByDateRange('yesterday', '2026-03-10T18:00:00Z'),
        ).rejects.toBeInstanceOf(z.ZodError);
      });
    });
  });
}

export function speakersContract(create: Factory<SpeakersRepository>): void {
  describe('speakers repository contract', () => {
    let seq = 0;
    baseContract<SpeakerInput, Speaker, SpeakerPatch, SpeakersRepository>({
      create,
      input: (n) =>
        speakerInput({
          name: `Speaker ${String(n)}`,
          email: `s${String(n)}-${String(seq++)}@example.com`,
        }),
      patch: { bio: 'Hello' },
      patched: ['bio', 'Hello'],
      unknownFieldInput: { ...speakerInput(), surprise: 1 },
      invalidPatch: { email: 'bad' },
    });

    describe('finders and rules', () => {
      let repo: SpeakersRepository;
      beforeEach(async () => {
        repo = await create();
      });

      it('lower-cases emails on write; findByEmail is case-insensitive', async () => {
        const doc = await repo.insert(speakerInput({ email: 'Ada@Example.COM' }));
        expect(doc.email).toBe('ada@example.com');
        expect((await repo.findByEmail('ADA@example.com'))?._id).toBe(doc._id);
        expect(await repo.findByEmail('nobody@example.com')).toBeNull();
        expect(await repo.findByEmail('not an email')).toBeNull();
      });

      it('a duplicate email (any case) on insert throws DuplicateKeyError naming the key', async () => {
        await repo.insert(speakerInput({ email: 'dup@example.com' }));
        const err = await repo
          .insert(speakerInput({ email: 'DUP@example.com' }))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DuplicateKeyError);
        expect(err).toMatchObject({ collection: 'speakers', keyPattern: { email: 1 } });
        expect((err as Error).message).not.toContain('dup@example.com'); // no personal data
        expect(await repo.count()).toBe(1);
      });

      it('a duplicate email on update throws DuplicateKeyError and changes nothing', async () => {
        await repo.insert(speakerInput({ name: 'A', email: 'a@example.com' }));
        const b = await repo.insert(speakerInput({ name: 'B', email: 'b@example.com' }));
        await expect(
          repo.updateById(b._id, { email: 'a@example.com' }, b.version),
        ).rejects.toBeInstanceOf(DuplicateKeyError);
        expect(await repo.findById(b._id)).toEqual(b);
      });

      it('allows any number of speakers without an email', async () => {
        await repo.insert(speakerInput({ name: 'No email 1' }));
        await repo.insert(speakerInput({ name: 'No email 2' }));
        expect(await repo.count()).toBe(2);
      });

      it('findByEventId: speakers with a perEvent entry for the event', async () => {
        const at = (eventId: string) => ({
          eventId,
          status: 'invited' as const,
          updatedAt: '2026-01-01T00:00:00Z',
        });
        await repo.insert(speakerInput({ name: 'A', perEvent: [at(ID_A)] }));
        await repo.insert(speakerInput({ name: 'B', perEvent: [at(ID_B)] }));
        await repo.insert(speakerInput({ name: 'AB', perEvent: [at(ID_A), at(ID_B)] }));
        expect((await repo.findByEventId(ID_A)).items.map((s) => s.name)).toEqual(['A', 'AB']);
        expect((await repo.findByEventId(ID_B, { limit: 1 })).items.map((s) => s.name)).toEqual([
          'B',
        ]);
        expect((await repo.findByEventId('not-an-id')).items).toEqual([]);
      });
    });
  });
}

export function organisationsContract(create: Factory<OrganisationsRepository>): void {
  describe('organisations repository contract', () => {
    baseContract<OrganisationInput, Organisation, OrganisationPatch, OrganisationsRepository>({
      create,
      input: (n) => organisationInput({ name: `Org ${String(n)}` }),
      patch: { kind: 'sponsor' },
      patched: ['kind', 'sponsor'],
      unknownFieldInput: { ...organisationInput(), surprise: 1 },
      invalidPatch: { kind: 'nope' },
    });

    it('findByKind: filters by kind and paginates', async () => {
      const repo = await create();
      await repo.insert(organisationInput({ name: 'v1', kind: 'venue' }));
      await repo.insert(organisationInput({ name: 's1', kind: 'sponsor' }));
      await repo.insert(organisationInput({ name: 'v2', kind: 'venue' }));
      const venues = await repo.findByKind('venue');
      expect(venues.items.map((o) => o.name)).toEqual(['v1', 'v2']);
      const first = await repo.findByKind('venue', { limit: 1 });
      expect(first.nextCursor).toBe(first.items[0]?._id);
      await expect(repo.findByKind('nope' as never)).rejects.toBeInstanceOf(z.ZodError);
    });
  });
}

export function tasksContract(create: Factory<TasksRepository>): void {
  describe('tasks repository contract', () => {
    baseContract<TaskInput, Task, TaskPatch, TasksRepository>({
      create,
      input: (n) => taskInput({ title: `Task ${String(n)}` }),
      patch: { status: 'done' },
      patched: ['status', 'done'],
      unknownFieldInput: { ...taskInput(), surprise: 1 },
      invalidPatch: { source: 'agent' },
    });

    describe('finders', () => {
      let repo: TasksRepository;
      beforeEach(async () => {
        repo = await create();
      });

      it('findByStatus: filters by status and paginates', async () => {
        await repo.insert(taskInput({ title: 'o1', status: 'open' }));
        await repo.insert(taskInput({ title: 'd1', status: 'done' }));
        await repo.insert(taskInput({ title: 'o2', status: 'open' }));
        expect((await repo.findByStatus('open')).items.map((t) => t.title)).toEqual(['o1', 'o2']);
        const first = await repo.findByStatus('open', { limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toBeDefined();
        await expect(repo.findByStatus({ $ne: 'x' } as never)).rejects.toBeInstanceOf(z.ZodError);
      });

      it('findDueBefore: strictly before, any status, ignores tasks without dueAt', async () => {
        await repo.insert(taskInput({ title: 'early', dueAt: '2026-01-01T00:00:00Z' }));
        await repo.insert(taskInput({ title: 'edge', dueAt: '2026-02-01T00:00:00Z' }));
        await repo.insert(taskInput({ title: 'late', dueAt: '2026-03-01T00:00:00Z' }));
        await repo.insert(
          taskInput({ title: 'done-early', status: 'done', dueAt: '2026-01-05T00:00:00Z' }),
        );
        await repo.insert(taskInput({ title: 'no-due' }));
        const r = await repo.findDueBefore('2026-02-01T00:00:00Z');
        expect(r.items.map((t) => t.title)).toEqual(['early', 'done-early']);
        await expect(repo.findDueBefore('soon')).rejects.toBeInstanceOf(z.ZodError);
      });
    });
  });
}
