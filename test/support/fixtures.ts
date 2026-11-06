import type { EventInput } from '../../src/domain/event.schema.js';
import type { OrganisationInput } from '../../src/domain/organisation.schema.js';
import type { SpeakerInput } from '../../src/domain/speaker.schema.js';
import type { TaskInput } from '../../src/domain/task.schema.js';

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
