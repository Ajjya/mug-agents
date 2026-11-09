import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fromStorage, toStorage } from '../../src/domain/common.js';
import {
  EVENT_PHASES,
  EventInputSchema,
  EventPatchSchema,
  EventSchema,
} from '../../src/domain/event.schema.js';
import {
  OrganisationInputSchema,
  OrganisationPatchSchema,
  OrganisationSchema,
  ORGANISATION_KINDS,
} from '../../src/domain/organisation.schema.js';
import {
  SPEAKER_STATUSES,
  SpeakerInputSchema,
  SpeakerPatchSchema,
  SpeakerSchema,
} from '../../src/domain/speaker.schema.js';
import {
  TASK_SOURCES,
  TASK_STATUSES,
  TaskInputSchema,
  TaskPatchSchema,
  TaskSchema,
} from '../../src/domain/task.schema.js';
import { ObjectId } from 'mongodb';
import {
  ID_A,
  ISO,
  eventInput,
  organisationInput,
  speakerInput,
  taskInput,
} from '../support/fixtures.js';

const rawDoc = () => ({
  _id: new ObjectId(),
  version: 1,
  createdAt: new Date(ISO),
  updatedAt: new Date(ISO),
});

describe('enum constants', () => {
  it('are exported and non-empty', () => {
    for (const list of [
      EVENT_PHASES,
      SPEAKER_STATUSES,
      ORGANISATION_KINDS,
      TASK_STATUSES,
      TASK_SOURCES,
    ]) {
      expect(list.length).toBeGreaterThan(0);
    }
  });
});

describe('Event', () => {
  it('accepts a valid input and converts ISO dates/ids to Date/ObjectId', () => {
    const stored = toStorage(
      EventInputSchema,
      eventInput({
        date: ISO,
        venueOrganisationId: ID_A,
        agenda: [{ title: 'Talk', startsAt: ISO, durationMin: 30 }],
      }),
    );
    expect(stored.date).toBeInstanceOf(Date);
    expect(stored.venueOrganisationId).toBeInstanceOf(ObjectId);
    expect(stored.agenda[0]?.startsAt).toBeInstanceOf(Date);
  });
  it('rejects invalid values', () => {
    expect(EventInputSchema.safeParse({ ...eventInput(), phase: 'nope' }).success).toBe(false);
    expect(() => toStorage(EventInputSchema, eventInput({ phase: 'nope' as never }))).toThrow(
      z.ZodError,
    );
    expect(() => toStorage(EventInputSchema, eventInput({ date: 'tomorrow' }))).toThrow(z.ZodError);
    expect(() => toStorage(EventInputSchema, eventInput({ capacity: -1 }))).toThrow(z.ZodError);
    expect(() => toStorage(EventInputSchema, eventInput({ coHostOrganisationIds: ['x'] }))).toThrow(
      z.ZodError,
    );
  });
  it('rejects unknown fields, including nested ones', () => {
    expect(() => toStorage(EventInputSchema, { ...eventInput(), surprise: 1 } as never)).toThrow(
      z.ZodError,
    );
    expect(() =>
      toStorage(EventInputSchema, eventInput({ agenda: [{ title: 'T', extra: 1 } as never] })),
    ).toThrow(z.ZodError);
  });
  it('reads a stored document back as ISO strings and hex ids', () => {
    const r = fromStorage(EventSchema, {
      ...rawDoc(),
      ...toStorage(EventInputSchema, eventInput({ date: ISO })),
    });
    expect(r.success && r.data.date).toBe(ISO);
    expect(r.success && r.data._id).toMatch(/^[0-9a-f]{24}$/);
  });
  it('patch is partial and strict', () => {
    expect(toStorage(EventPatchSchema, { phase: 'planning' })).toEqual({ phase: 'planning' });
    expect(() => toStorage(EventPatchSchema, { nope: 1 } as never)).toThrow(z.ZodError);
  });
});

describe('Speaker', () => {
  it('accepts valid input with date conversion in perEvent', () => {
    const s = toStorage(
      SpeakerInputSchema,
      speakerInput({
        email: 'a@b.pt',
        perEvent: [{ eventId: ID_A, status: 'invited', updatedAt: ISO }],
      }),
    );
    expect(s.perEvent[0]?.updatedAt).toBeInstanceOf(Date);
  });
  it('rejects invalid email, status and unknown fields', () => {
    expect(() => toStorage(SpeakerInputSchema, speakerInput({ email: 'nope' }))).toThrow(
      z.ZodError,
    );
    expect(() =>
      toStorage(
        SpeakerInputSchema,
        speakerInput({ perEvent: [{ eventId: ID_A, status: 'x' as never, updatedAt: ISO }] }),
      ),
    ).toThrow(z.ZodError);
    expect(() =>
      toStorage(SpeakerInputSchema, { ...speakerInput(), twitter: 'x' } as never),
    ).toThrow(z.ZodError);
    expect(() =>
      toStorage(
        SpeakerInputSchema,
        speakerInput({ links: { twitter: 'https://x.com/a' } as never }),
      ),
    ).toThrow(z.ZodError);
  });
  it('reads back and patches', () => {
    const r = fromStorage(SpeakerSchema, {
      ...rawDoc(),
      ...toStorage(SpeakerInputSchema, speakerInput()),
    });
    expect(r.success).toBe(true);
    expect(toStorage(SpeakerPatchSchema, { bio: 'hi' })).toEqual({ bio: 'hi' });
    expect(() => toStorage(SpeakerPatchSchema, { x: 1 } as never)).toThrow(z.ZodError);
  });
});

describe('Organisation', () => {
  it('accepts valid input', () => {
    const o = toStorage(
      OrganisationInputSchema,
      organisationInput({
        contacts: [{ name: 'Bob', email: 'b@c.pt' }],
        history: [{ eventId: ID_A, role: 'venue' }],
      }),
    );
    expect(o.history[0]?.eventId).toBeInstanceOf(ObjectId);
  });
  it('rejects invalid kind, contact email, history role and unknown fields', () => {
    expect(() =>
      toStorage(OrganisationInputSchema, organisationInput({ kind: 'x' as never })),
    ).toThrow(z.ZodError);
    expect(() =>
      toStorage(
        OrganisationInputSchema,
        organisationInput({ contacts: [{ name: 'B', email: 'bad' }] }),
      ),
    ).toThrow(z.ZodError);
    expect(() =>
      toStorage(
        OrganisationInputSchema,
        organisationInput({ history: [{ eventId: ID_A, role: 'x' as never }] }),
      ),
    ).toThrow(z.ZodError);
    expect(() =>
      toStorage(OrganisationInputSchema, { ...organisationInput(), extra: 1 } as never),
    ).toThrow(z.ZodError);
  });
  it('reads back and patches', () => {
    expect(
      fromStorage(OrganisationSchema, {
        ...rawDoc(),
        ...toStorage(OrganisationInputSchema, organisationInput()),
      }).success,
    ).toBe(true);
    expect(toStorage(OrganisationPatchSchema, { kind: 'sponsor' })).toEqual({ kind: 'sponsor' });
  });
});

describe('Task', () => {
  it('accepts valid input and converts dueAt', () => {
    const t = toStorage(TaskInputSchema, taskInput({ dueAt: ISO, relatedEventId: ID_A }));
    expect(t.dueAt).toBeInstanceOf(Date);
  });
  it('rejects invalid status, empty title, bad date and unknown fields', () => {
    expect(() => toStorage(TaskInputSchema, taskInput({ status: 'x' as never }))).toThrow(
      z.ZodError,
    );
    expect(() => toStorage(TaskInputSchema, taskInput({ title: '  ' }))).toThrow(z.ZodError);
    expect(() => toStorage(TaskInputSchema, taskInput({ dueAt: '2026-13-45' }))).toThrow(
      z.ZodError,
    );
    expect(() => toStorage(TaskInputSchema, { ...taskInput(), createdAt: ISO } as never)).toThrow(
      z.ZodError,
    );
  });
  it('patch excludes immutable source', () => {
    expect(toStorage(TaskPatchSchema, { status: 'done' })).toEqual({ status: 'done' });
    expect(() => toStorage(TaskPatchSchema, { source: 'agent' } as never)).toThrow(z.ZodError);
    expect(
      fromStorage(TaskSchema, { ...rawDoc(), ...toStorage(TaskInputSchema, taskInput()) }).success,
    ).toBe(true);
  });
});

describe('storage reads', () => {
  it('fail on unknown stored fields (schema drift)', () => {
    const raw = { ...rawDoc(), ...toStorage(TaskInputSchema, taskInput()), legacy: true };
    expect(fromStorage(TaskSchema, raw).success).toBe(false);
  });
});
