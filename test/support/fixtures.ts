import type { EventInput } from '../../src/domain/event.schema.js';
import type { OrganisationInput } from '../../src/domain/organisation.schema.js';
import type { SpeakerInput } from '../../src/domain/speaker.schema.js';
import type { TaskInput } from '../../src/domain/task.schema.js';
import { type MessageInput, messageIdempotencyKey } from '../../src/domain/message.schema.js';

export const ID_A = 'a'.repeat(24);
export const ID_B = 'b'.repeat(24);
export const ISO = '2026-03-12T18:30:00.000Z';

export const eventInput = (over: Partial<EventInput> = {}): EventInput => ({
  title: 'MUG Lisbon #1',
  phase: 'idea',
  coHostOrganisationIds: [],
  agenda: [],
  ...over,
});

export const speakerInput = (over: Partial<SpeakerInput> = {}): SpeakerInput => ({
  name: 'Ada Lovelace',
  topics: ['aggregation'],
  links: {},
  perEvent: [],
  ...over,
});

export const organisationInput = (over: Partial<OrganisationInput> = {}): OrganisationInput => ({
  name: 'Acme Lisbon',
  kind: 'venue',
  contacts: [],
  history: [],
  ...over,
});

export const taskInput = (over: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Book venue',
  owner: 'vlad',
  status: 'open',
  source: 'manual',
  ...over,
});

export const messageInput = (over: Partial<MessageInput> = {}): MessageInput => {
  const base = {
    eventId: ID_A,
    speakerId: ID_B,
    kind: 'invitation' as const,
    round: 1,
    ...over,
  };
  return {
    channel: 'email',
    subject: 'Speak at {{event_title}}?',
    body: 'Hello Ada, would you speak at MUG Lisbon #1?',
    facts: { speaker_name: 'Ada', event_title: 'MUG Lisbon #1' },
    reason: 'idea, T-6w reached',
    needsApproval: true,
    status: 'draft',
    idempotencyKey: messageIdempotencyKey(base.eventId, base.speakerId, base.kind, base.round),
    ...base,
    ...over,
  };
};
