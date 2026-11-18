import type { InboundMessageInput } from '../../src/domain/inbox.schema.js';

export const inboundInput = (over: Partial<InboundMessageInput> = {}): InboundMessageInput => ({
  gmailId: 'g-1',
  threadId: 't-1',
  rfcMessageId: '<abc@mail.invalid>',
  receivedAt: '2026-11-01T10:00:00.000Z',
  from: { name: 'Wendeline Gooseberry', address: 'wendeline@speakers.invalid' },
  to: [{ address: 'organiser@mug.invalid' }],
  subject: 'Re: Winter Meetup',
  bodyText: 'Yes, I would love to speak.\n\nWendeline',
  bodyRedacted: 'Yes, I would love to speak.',
  bodySnippet: 'Yes, I would love to speak.',
  labelIds: ['Label_mug'],
  attachments: [],
  classification: 'personal',
  triageState: 'pending',
  linkState: 'unlinked',
  ...over,
});
