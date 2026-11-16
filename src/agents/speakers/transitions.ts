import { SPEAKER_STATUSES, type SpeakerStatus } from '../../domain/speaker.schema.js';

/**
 * Allowed `speakers.perEvent[].status` transitions: one table, one guard. Anything not listed throws.
 *
 * `satisfies Record<SpeakerStatus, ...>` makes the table exhaustive at compile time: a status added to
 * SPEAKER_STATUSES without a row here fails `npm run typecheck`. Frozen, so nothing changes it at run time.
 */
export const SPEAKER_TRANSITIONS: Readonly<Record<SpeakerStatus, readonly SpeakerStatus[]>> =
  Object.freeze({
    idea: ['invited', 'declined'],
    // idea = parked, not a regression
    invited: ['confirmed', 'declined', 'idea'],
    confirmed: ['abstract_received', 'declined'],
    abstract_received: ['slides_received', 'declined'],
    slides_received: ['thanked'],
    // re-approach for a later event
    declined: ['idea'],
    thanked: [],
  } satisfies Record<SpeakerStatus, readonly SpeakerStatus[]>);

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: SpeakerStatus,
    public readonly to: SpeakerStatus,
  ) {
    const allowed = SPEAKER_TRANSITIONS[from];
    super(
      `A speaker cannot go from "${from}" to "${to}". Allowed from "${from}": ${
        allowed.length > 0 ? allowed.join(', ') : 'nothing (terminal)'
      }`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: SpeakerStatus, to: SpeakerStatus): boolean {
  return SPEAKER_TRANSITIONS[from].includes(to);
}

/** The guard. Every status write goes through it. */
export function assertTransition(from: SpeakerStatus, to: SpeakerStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** Every (from, to) pair, for tests and the README. */
export function allTransitions(): { from: SpeakerStatus; to: SpeakerStatus; allowed: boolean }[] {
  return SPEAKER_STATUSES.flatMap((from) =>
    SPEAKER_STATUSES.map((to) => ({ from, to, allowed: canTransition(from, to) })),
  );
}
