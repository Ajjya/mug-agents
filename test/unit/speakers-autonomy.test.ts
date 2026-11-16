import { describe, expect, it } from 'vitest';
import { messageAutonomyAction, needsApproval } from '../../src/agents/speakers/autonomy.js';
import { MESSAGE_KINDS } from '../../src/domain/message.schema.js';

describe('speaker messages and the autonomy table', () => {
  it.each(MESSAGE_KINDS.map((k) => [k]))(
    '%s to a speaker never contacted needs approval',
    (kind) => {
      expect(messageAutonomyAction(kind, false)).toBe('first_contact_message');
      expect(needsApproval(kind, false)).toBe(true);
    },
  );

  it('in an existing thread: chases, invitations and thank-yous are auto', () => {
    expect(messageAutonomyAction('chase_reply', true)).toBe('chase_in_existing_thread');
    expect(messageAutonomyAction('chase_slides', true)).toBe('chase_in_existing_thread');
    expect(messageAutonomyAction('invitation', true)).toBe('draft_speaker_message');
    expect(messageAutonomyAction('thank_you', true)).toBe('thank_you_message');
    for (const kind of MESSAGE_KINDS) expect(needsApproval(kind, true)).toBe(false);
  });
});
