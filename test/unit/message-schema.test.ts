import { describe, expect, it } from 'vitest';
import { toStorage } from '../../src/domain/common.js';
import {
  MessageInputSchema,
  isRecordedOutside,
  recordedBy,
} from '../../src/domain/message.schema.js';
import { messageInput } from '../support/fixtures.js';

const valid = (over: Parameters<typeof messageInput>[0]) => {
  try {
    toStorage(MessageInputSchema, messageInput(over));
    return true;
  } catch {
    return false;
  }
};

describe('message body rules', () => {
  it('a normal message needs text', () => {
    expect(valid({ body: 'Hello' })).toBe(true);
    expect(valid({ body: '' })).toBe(false);
    expect(valid({ body: '   ' })).toBe(false);
  });

  it('an empty body is allowed only for a SENT message recorded outside the system', () => {
    const recorded = { body: '', status: 'sent' as const, sentAt: '2026-11-01T12:00:00.000Z' };
    expect(valid({ ...recorded, sentBy: recordedBy('vlad') })).toBe(true);
    expect(valid({ ...recorded, sentBy: 'vlad' })).toBe(false); // sent by the CLI: it had text
    expect(valid({ ...recorded })).toBe(false);
    expect(valid({ body: '', status: 'draft', sentBy: recordedBy('vlad') })).toBe(false);
    expect(valid({ body: '', status: 'approved', sentBy: recordedBy('vlad') })).toBe(false);
  });

  it('the marker lives in one place', () => {
    expect(isRecordedOutside({ sentBy: recordedBy('vlad') })).toBe(true);
    expect(isRecordedOutside({ sentBy: 'vlad' })).toBe(false);
    expect(isRecordedOutside({})).toBe(false);
  });
});
