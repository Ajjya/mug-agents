import { ENTITY_ID_RE } from '../domain/common.js';

/** What a graph thread is for. One thread per (event, purpose): that is what makes it unique. */
export const THREAD_PURPOSES = ['plan'] as const;
export type ThreadPurpose = (typeof THREAD_PURPOSES)[number];

export interface ThreadRef {
  kind: 'event';
  /** Lower-case 24-hex entity id. */
  eventId: string;
  purpose: ThreadPurpose;
}

export type ParsedThread = { ok: true; value: ThreadRef } | { ok: false; error: string };

/**
 * `event:<eventId>:plan`. Deterministic, so planning the same event again lands on the same thread
 * (continue it) instead of forking a parallel one: two threads for the same purpose cannot exist,
 * because there is no way to build a second id for it.
 */
export function threadIdFor(eventId: string, purpose: ThreadPurpose = 'plan'): string {
  if (!ENTITY_ID_RE.test(eventId)) {
    throw new RangeError(
      `Cannot build a thread id: "${eventId}" is not a 24-character hex event id`,
    );
  }
  return `event:${eventId.toLowerCase()}:${purpose}`;
}

/**
 * Total: every string yields either a ThreadRef or an error message, never an exception and never
 * a half-parsed value. This is the only place a thread id is taken apart.
 */
export function parseThreadId(threadId: string): ParsedThread {
  const parts = threadId.split(':');
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `thread id must look like "event:<eventId>:<purpose>", got "${threadId}"`,
    };
  }
  const [kind, eventId, purpose] = parts as [string, string, string];
  if (kind !== 'event') return { ok: false, error: `unknown thread kind "${kind}"` };
  if (!ENTITY_ID_RE.test(eventId)) {
    return { ok: false, error: `"${eventId}" is not a 24-character hex event id` };
  }
  if (!(THREAD_PURPOSES as readonly string[]).includes(purpose)) {
    return { ok: false, error: `unknown thread purpose "${purpose}"` };
  }
  return {
    ok: true,
    value: { kind: 'event', eventId: eventId.toLowerCase(), purpose: purpose as ThreadPurpose },
  };
}
