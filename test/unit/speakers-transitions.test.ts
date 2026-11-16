import { describe, expect, expectTypeOf, it } from 'vitest';
import { SPEAKER_STATUSES, type SpeakerStatus } from '../../src/domain/speaker.schema.js';
import {
  IllegalTransitionError,
  SPEAKER_TRANSITIONS,
  allTransitions,
  assertTransition,
} from '../../src/agents/speakers/transitions.js';

/** The M3b spec's table, written out independently of the implementation. */
const SPEC: Record<SpeakerStatus, SpeakerStatus[]> = {
  idea: ['invited', 'declined'],
  invited: ['confirmed', 'declined', 'idea'],
  confirmed: ['abstract_received', 'declined'],
  abstract_received: ['slides_received', 'declined'],
  slides_received: ['thanked'],
  declined: ['idea'],
  thanked: [],
};

describe('speaker status transitions', () => {
  it('match the spec table exactly', () => {
    for (const from of SPEAKER_STATUSES) {
      expect([...SPEAKER_TRANSITIONS[from]].sort()).toEqual([...SPEC[from]].sort());
    }
  });

  const pairs = allTransitions();
  it.each(pairs.filter((p) => p.allowed).map((p) => [p.from, p.to]))(
    'allows %s -> %s',
    (from, to) => {
      expect(() => {
        assertTransition(from, to);
      }).not.toThrow();
    },
  );

  // Every pair not in the table, self-transitions included.
  it.each(pairs.filter((p) => !p.allowed).map((p) => [p.from, p.to]))(
    'refuses %s -> %s',
    (from, to) => {
      expect(() => {
        assertTransition(from, to);
      }).toThrow(IllegalTransitionError);
    },
  );

  it('covers all 49 pairs; thanked is terminal', () => {
    expect(pairs).toHaveLength(SPEAKER_STATUSES.length ** 2);
    expect(() => {
      assertTransition('thanked', 'idea');
    }).toThrow(/terminal/);
  });

  it('is exhaustive at compile time and frozen at run time', () => {
    expectTypeOf<keyof typeof SPEAKER_TRANSITIONS>().toEqualTypeOf<SpeakerStatus>();
    // @ts-expect-error a table missing a status does not type-check
    const incomplete: Record<SpeakerStatus, readonly SpeakerStatus[]> = { idea: [] };
    expect(incomplete).toBeDefined();
    expect(Object.isFrozen(SPEAKER_TRANSITIONS)).toBe(true);
  });
});
