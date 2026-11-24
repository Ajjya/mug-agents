import { describe, expect, it } from 'vitest';
import { FakeGmail, type FixtureMessage } from '../support/fake-gmail.js';
import { buildInboxHarness } from '../support/inbox-harness.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');

const msg = (
  over: Partial<FixtureMessage> & Pick<FixtureMessage, 'id' | 'threadId'>,
): FixtureMessage => ({
  labels: ['Label_1'],
  receivedAt: '2026-10-30T09:00:00.000Z',
  from: 'Someone <someone@people.invalid>',
  to: 'organiser@mug.invalid',
  subject: `Subject ${over.id}`,
  messageId: `<${over.id}@people.invalid>`,
  body: `Body of ${over.id}`,
  attachments: [],
  ...over,
});

async function world(...messages: FixtureMessage[]) {
  const gmail = FakeGmail.empty();
  for (const m of messages) gmail.receive(m);
  const h = buildInboxHarness({ gmail });
  await h.service.poll({ now: NOW }); // stored before the speaker exists: unlinked
  const event = await h.repos.events.insert({
    title: 'Meetup',
    phase: 'planning',
    date: '2026-12-12T00:00:00.000Z',
    coHostOrganisationIds: [],
    agenda: [],
  });
  return { h, gmail, event };
}

const addSpeaker = async (
  h: Awaited<ReturnType<typeof world>>['h'],
  eventId: string,
  emails: string[],
  name = 'Ana Pires',
) =>
  await h.repos.speakers.insert({
    name,
    emails,
    handles: {},
    topics: [],
    links: {},
    perEvent: [{ eventId, status: 'invited', updatedAt: '2026-10-01T00:00:00.000Z' }],
  });

describe('inbox relink: the linking rules over stored messages, with no Gmail and no model', () => {
  it('a message stored before its speaker existed is linked after the speaker is seeded; one matching nobody stays unlinked', async () => {
    const { h, gmail, event } = await world(
      msg({ id: 'a1', threadId: 't1', from: 'Ana <ana@speakers.invalid>' }),
      msg({ id: 'x1', threadId: 't2', from: 'Stranger <nobody@else.invalid>' }),
    );
    for (const id of ['a1', 'x1'])
      expect((await h.repos.inbound.findByGmailId(id))?.linkState).toBe('unlinked');
    const ana = await addSpeaker(h, event._id, ['ana@speakers.invalid']);
    const gmailBefore = JSON.stringify(gmail.calls);
    const modelBefore = h.model.prompts.length;

    const r = await h.service.relink();

    expect(r).toMatchObject({
      considered: 2,
      moved: 1,
      stillUnlinked: 1,
      byAddress: 1,
      byThread: 0,
    });
    expect(await h.repos.inbound.findByGmailId('a1')).toMatchObject({
      linkState: 'auto',
      linkedSpeakerId: ana._id,
      linkedEventId: event._id,
    });
    expect((await h.repos.inbound.findByGmailId('x1'))?.linkState).toBe('unlinked');
    // COUNTED: nothing was fetched from Gmail, no model was called.
    expect(JSON.stringify(gmail.calls)).toBe(gmailBefore);
    expect(h.model.prompts.length).toBe(modelBefore);
    // And a reply we only now know is hers pauses chasing, as it would have at poll time.
    expect((await h.repos.speakers.findById(ana._id))?.perEvent[0]?.lastInboundAt).toBe(
      '2026-10-30T09:00:00.000Z',
    );
  });

  it('a NAME match never links: same display name, different address', async () => {
    const { h, event } = await world(
      msg({ id: 'n1', threadId: 't1', from: 'Ana Pires <someone.else@elsewhere.invalid>' }),
    );
    await addSpeaker(h, event._id, ['ana@speakers.invalid'], 'Ana Pires');
    const r = await h.service.relink();
    expect(r).toMatchObject({ moved: 0, stillUnlinked: 1 });
    expect((await h.repos.inbound.findByGmailId('n1'))?.linkState).toBe('unlinked');
  });

  it('thread inheritance: a later message in her thread from another address follows the earlier one', async () => {
    const { h, event } = await world(
      msg({
        id: 'a1',
        threadId: 't1',
        from: 'Ana <ana@speakers.invalid>',
        receivedAt: '2026-10-28T09:00:00.000Z',
      }),
      msg({
        id: 'a2',
        threadId: 't1',
        from: 'Her assistant <pa@speakers.invalid>',
        receivedAt: '2026-10-29T09:00:00.000Z',
      }),
    );
    const ana = await addSpeaker(h, event._id, ['ana@speakers.invalid']);
    const r = await h.service.relink();
    expect(r).toMatchObject({ moved: 2, byAddress: 1, byThread: 1 });
    expect((await h.repos.inbound.findByGmailId('a2'))?.linkedSpeakerId).toBe(ana._id);
  });

  it('confirmed_by_human and auto links are never touched', async () => {
    const { h, event } = await world(
      msg({ id: 'c1', threadId: 't1', from: 'Ana <ana@speakers.invalid>' }),
      msg({ id: 'c2', threadId: 't2', from: 'Other <other@speakers.invalid>' }),
    );
    const ana = await addSpeaker(h, event._id, ['ana@speakers.invalid']);
    const rui = await addSpeaker(h, event._id, ['rui@speakers.invalid'], 'Rui');
    // you decided c2 is Rui's, by hand, whatever its address says
    const c2 = await h.repos.inbound.findByGmailId('c2');
    await h.service.link(c2?._id ?? '', rui._id, event._id);
    const before = JSON.stringify(await h.repos.inbound.findByGmailId('c2'));
    const r = await h.service.relink();
    expect(r.considered).toBe(1); // only c1 is unlinked
    expect(JSON.stringify(await h.repos.inbound.findByGmailId('c2'))).toBe(before);
    expect((await h.repos.inbound.findByGmailId('c2'))?.linkState).toBe('confirmed_by_human');
    expect((await h.repos.inbound.findByGmailId('c1'))?.linkedSpeakerId).toBe(ana._id);
  });

  it('--dry-run reports what would move and writes nothing; a second real run is a no-op', async () => {
    const { h, event } = await world(
      msg({ id: 'a1', threadId: 't1', from: 'Ana <ana@speakers.invalid>' }),
    );
    const ana = await addSpeaker(h, event._id, ['ana@speakers.invalid']);
    const dry = await h.service.relink({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, moved: 1 });
    expect((await h.repos.inbound.findByGmailId('a1'))?.linkState).toBe('unlinked');
    expect((await h.repos.speakers.findById(ana._id))?.perEvent[0]?.lastInboundAt).toBeUndefined();
    expect((await h.service.relink()).moved).toBe(1);
    expect(await h.service.relink()).toMatchObject({ considered: 0, moved: 0 });
  });

  it('a platform sender is never linked, even if a speaker has its address', async () => {
    const { h, event } = await world(
      msg({ id: 'p1', threadId: 't1', from: 'Slack <notify@slack.invalid>' }),
    );
    await addSpeaker(h, event._id, ['notify@slack.invalid']);
    await h.service.setContactRole('notify@slack.invalid', 'platform', 'test');
    const r = await h.service.relink();
    expect(r).toMatchObject({ moved: 0, skippedPlatform: 1 });
  });

  it('--limit bounds how many stored messages are looked at', async () => {
    const { h, event } = await world(
      msg({ id: 'a1', threadId: 't1', from: 'Ana <ana@speakers.invalid>' }),
      msg({
        id: 'a2',
        threadId: 't2',
        from: 'Ana <ana@speakers.invalid>',
        receivedAt: '2026-10-31T09:00:00.000Z',
      }),
    );
    await addSpeaker(h, event._id, ['ana@speakers.invalid']);
    expect((await h.service.relink({ limit: 1 })).considered).toBe(1);
  });
});
