import { describe, expect, it } from 'vitest';
import { InboundMessageInputSchema, isStringifiedNothing } from '../../src/domain/inbox.schema.js';
import { ImapGmailClient } from '../../src/inbox/imap.client.js';
import { FakeGmail, type FixtureMessage } from '../support/fake-gmail.js';
import { FakeImapSession } from '../support/fake-imap.js';
import { buildInboxHarness } from '../support/inbox-harness.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');

const msg = (
  over: Partial<FixtureMessage> & Pick<FixtureMessage, 'id' | 'threadId'>,
): FixtureMessage => ({
  labels: ['Label_1'],
  receivedAt: '2026-10-30T09:00:00.000Z',
  from: 'LinkedIn <linkedin@em.invalid>',
  to: 'organiser@mug.invalid',
  subject: 'Your Page has been mentioned!',
  messageId: `<${over.id}@em.invalid>`,
  body: '',
  attachments: [],
  ...over,
});

const HTML =
  '<html><head><style>p{color:red}</style></head><body><p>Your Page has been <b>mentioned</b>!</p><p>Open LinkedIn to see who.</p></body></html>';

async function extract(m: FixtureMessage) {
  const gmail = FakeGmail.empty();
  gmail.receive(m);
  const warnings: { message: string; fields: Record<string, string> }[] = [];
  const client = new ImapGmailClient(
    () => new FakeImapSession(gmail),
    ['mug-agents', 'mug-maybe'],
    [],
    (message, fields) => warnings.push({ message, fields }),
  );
  await client.resolveLabelId('mug-agents');
  const [ref] = (await client.listMessageRefs({ labelId: 'mug-agents', limit: 5 })).refs;
  if (!ref) throw new Error('no ref');
  return { full: await client.getFull(ref), warnings };
}

describe('body extraction: an HTML-only message is converted, never stored as "undefined"', () => {
  it('no text/plain part: the text/html part becomes plain text (not empty, not "undefined")', async () => {
    const { full, warnings } = await extract(
      msg({ id: 'h1', threadId: 't1', bodyParts: [{ type: 'text/html', content: HTML }] }),
    );
    expect(full.bodyText).not.toBe('');
    expect(full.bodyText).not.toContain('undefined');
    expect(full.bodyText).toContain('Your Page has been mentioned!');
    expect(full.bodyText).toContain('Open LinkedIn to see who.');
    expect(full.bodyText).not.toMatch(/<|color:red/); // tags and style are gone
    expect(warnings).toEqual([]);
  });

  it('a text/plain part that is literally "undefined" (a template that printed a missing value) is not used: the HTML is', async () => {
    const { full } = await extract(
      msg({
        id: 'h2',
        threadId: 't2',
        bodyParts: [
          { type: 'text/plain', content: 'undefined\r\n' },
          { type: 'text/html', content: HTML },
        ],
      }),
    );
    expect(full.bodyText).toContain('Your Page has been mentioned!');
    expect(isStringifiedNothing(full.bodyText)).toBe(false);
  });

  it('a real text/plain part still wins over HTML (nothing changed for ordinary mail)', async () => {
    const { full } = await extract(
      msg({
        id: 'h3',
        threadId: 't3',
        bodyParts: [
          { type: 'text/plain', content: 'The plain version.' },
          { type: 'text/html', content: HTML },
        ],
      }),
    );
    expect(full.bodyText).toBe('The plain version.');
  });

  it('no usable body part at all: an empty string, and a warning that carries the gmailId (and nothing else)', async () => {
    const { full, warnings } = await extract(
      msg({
        id: 'h4',
        threadId: 't4',
        bodyParts: [],
        attachments: [{ filename: 'invite.pdf', mimeType: 'application/pdf', sizeBytes: 10 }],
      }),
    );
    expect(full.bodyText).toBe('');
    expect(warnings.map((w) => w.fields)).toEqual([{ gmailId: 'h4' }]);
    expect(warnings[0]?.message).toMatch(/no usable body part/);
    // a blank or "null" part is no better than none
    const blank = await extract(
      msg({ id: 'h5', threadId: 't5', bodyParts: [{ type: 'text/plain', content: ' null \r\n' }] }),
    );
    expect(blank.full.bodyText).toBe('');
    expect(blank.warnings).toHaveLength(1);
  });

  it('end to end: the poll stores the converted HTML, never the literal', async () => {
    const gmail = FakeGmail.empty();
    gmail.receive(
      msg({ id: 'h6', threadId: 't6', bodyParts: [{ type: 'text/html', content: HTML }] }),
    );
    const client = new ImapGmailClient(
      () => new FakeImapSession(gmail),
      ['mug-agents', 'mug-maybe'],
    );
    const h = buildInboxHarness({ gmail, client });
    await h.service.poll({ now: NOW });
    const stored = await h.repos.inbound.findByGmailId('h6');
    const raw = await h.repos.inbound.getRawBody(stored?._id ?? '');
    expect(raw).toContain('Your Page has been mentioned!');
    expect(isStringifiedNothing(raw ?? '')).toBe(false);
    expect(stored?.bodyRedacted).toContain('mentioned');
  });
});

describe('the guard: what is written to bodyText cannot be "undefined" or "null"', () => {
  const input = (bodyText: string) => ({
    gmailId: 'g1',
    threadId: 't',
    receivedAt: new Date('2026-10-30T09:00:00.000Z'),
    from: { address: 'a@b.invalid' },
    to: [],
    subject: 's',
    bodyText,
    bodyRedacted: 'x',
    bodySnippet: 'x',
    labelIds: [],
    attachments: [],
    classification: 'personal',
    triageState: 'pending',
    linkState: 'unlinked',
  });
  it.each(['undefined', 'null', 'undefined\r\n', '  null  '])('refuses %j', (v) => {
    expect(InboundMessageInputSchema.safeParse(input(v)).success).toBe(false);
  });
  it.each(['', 'Hello', 'the word undefined inside a sentence', 'nullable'])('accepts %j', (v) => {
    expect(InboundMessageInputSchema.safeParse(input(v)).success).toBe(true);
  });
  it('the repository refuses it too: nothing can write it, whatever called insert', async () => {
    const h = buildInboxHarness();
    const ok = InboundMessageInputSchema.parse(input('fine'));
    await expect(h.repos.inbound.insert({ ...ok, bodyText: 'undefined' })).rejects.toThrow();
    await expect(h.repos.inbound.insert({ ...ok, bodyText: 'null' })).rejects.toThrow();
    expect((await h.repos.inbound.insert(ok)).created).toBe(true);
  });
});
