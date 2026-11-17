import { describe, expect, it } from 'vitest';
import { MESSAGE_KINDS, messageIdempotencyKey } from '../../src/domain/message.schema.js';

const E = 'A'.repeat(24);
const S = 'b'.repeat(24);

describe('messageIdempotencyKey: the natural key (eventId, speakerId, kind, round)', () => {
  it('is the four parts, case-normalised', () => {
    expect(messageIdempotencyKey(E, S, 'chase_slides', 2)).toBe(
      `${'a'.repeat(24)}:${'b'.repeat(24)}:chase_slides:2`,
    );
    expect(messageIdempotencyKey(E, S, 'invitation', 1)).toBe(
      messageIdempotencyKey(E.toLowerCase(), S.toUpperCase(), 'invitation', 1),
    );
  });

  it('differs when any one part differs', () => {
    const base = messageIdempotencyKey(E, S, 'invitation', 1);
    expect(messageIdempotencyKey('c'.repeat(24), S, 'invitation', 1)).not.toBe(base);
    expect(messageIdempotencyKey(E, 'c'.repeat(24), 'invitation', 1)).not.toBe(base);
    expect(messageIdempotencyKey(E, S, 'invitation', 2)).not.toBe(base);
    const kinds = new Set(MESSAGE_KINDS.map((k) => messageIdempotencyKey(E, S, k, 1)));
    expect(kinds.size).toBe(MESSAGE_KINDS.length);
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])('refuses round %s', (round) => {
    expect(() => messageIdempotencyKey(E, S, 'invitation', round)).toThrow(RangeError);
  });
});
