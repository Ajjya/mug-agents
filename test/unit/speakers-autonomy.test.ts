import { describe, expect, it } from 'vitest';
import { messageAutonomyAction, needsApproval } from '../../src/agents/speakers/autonomy.js';
import { DRAFT_KINDS } from '../../src/domain/message.schema.js';

describe('speaker messages and the autonomy table', () => {
  it('chases and thank-yous are drafted in an existing thread: auto', () => {
    expect(messageAutonomyAction('chase_reply')).toBe('chase_in_existing_thread');
    expect(messageAutonomyAction('chase_slides')).toBe('chase_in_existing_thread');
    expect(messageAutonomyAction('thank_you')).toBe('thank_you_message');
    for (const kind of DRAFT_KINDS) expect(needsApproval(kind)).toBe(false);
  });
});
