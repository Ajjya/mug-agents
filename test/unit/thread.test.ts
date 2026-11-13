import { describe, expect, it } from 'vitest';
import { THREAD_PURPOSES, parseThreadId, threadIdFor } from '../../src/graph/thread.js';

const ID = 'a1b2c3d4e5f60718293a4b5c';

describe('threadIdFor', () => {
  it('is deterministic: event:<eventId>:plan', () => {
    expect(threadIdFor(ID)).toBe(`event:${ID}:plan`);
    expect(threadIdFor(ID)).toBe(threadIdFor(ID, 'plan'));
  });

  it('normalises case so one event has exactly one thread id', () => {
    expect(threadIdFor(ID.toUpperCase())).toBe(threadIdFor(ID));
  });

  it('refuses a malformed event id', () => {
    expect(() => threadIdFor('nope')).toThrow(RangeError);
    expect(() => threadIdFor('a'.repeat(23))).toThrow(RangeError);
    expect(() => threadIdFor('')).toThrow(RangeError);
  });
});

describe('parseThreadId', () => {
  it('round-trips with threadIdFor for every purpose', () => {
    for (const purpose of THREAD_PURPOSES) {
      expect(parseThreadId(threadIdFor(ID, purpose))).toEqual({
        ok: true,
        value: { kind: 'event', eventId: ID, purpose },
      });
    }
  });

  it('is total: every string gives ok or a message, nothing throws', () => {
    const inputs = [
      '',
      ':',
      '::',
      'event',
      'event:',
      `event:${ID}`,
      `event:${ID}:`,
      `event:${ID}:plan:extra`,
      `event::plan`,
      `event:${ID}:send`,
      `thread:${ID}:plan`,
      `event:${'z'.repeat(24)}:plan`,
      ' event:x:plan',
      '\u0000',
      'a'.repeat(10_000),
    ];
    for (const input of inputs) {
      const r = parseThreadId(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['unknown kind', `thread:${ID}:plan`, /unknown thread kind/],
    ['bad event id', 'event:xyz:plan', /not a 24-character hex/],
    ['unknown purpose', `event:${ID}:send`, /unknown thread purpose/],
    ['wrong part count', `event:${ID}`, /must look like/],
  ])('gives a specific message for %s', (_n, input, message) => {
    const r = parseThreadId(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('lower-cases the event id', () => {
    const r = parseThreadId(`event:${ID.toUpperCase()}:plan`);
    expect(r).toMatchObject({ ok: true, value: { eventId: ID } });
  });
});
