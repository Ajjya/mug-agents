import { describe, expect, it } from 'vitest';
import { channelOf, chooseDelivery } from '../../src/agents/speakers/delivery.js';
import { allPages } from '../../src/agents/planner/plan-persistence.js';
import { InboxInputError } from '../../src/inbox/inbox.service.js';
import { FakeGmail, type FixtureMessage } from '../support/fake-gmail.js';
import { buildInboxHarness } from '../support/inbox-harness.js';
import { buildSpeakersHarness, inMemorySpeakerRepos } from '../support/speakers-harness.js';
import { day, eventMessages, seed } from '../support/speakers-workflow-suite.js';

describe('chooseDelivery (pure)', () => {
  it('is email when an address exists, else the first handle, else no_contact', () => {
    expect(chooseDelivery({ emails: ['a@b.invalid'], handles: { linkedin: 'x' } })).toBe('email');
    expect(chooseDelivery({ emails: [], handles: { whatsapp: '+351', linkedin: 'l' } })).toBe(
      'manual:linkedin',
    );
    expect(chooseDelivery({ emails: [], handles: { whatsapp: '+351' } })).toBe('manual:whatsapp');
    expect(chooseDelivery({ emails: [], handles: { other: 'signal' } })).toBe('manual:other');
    expect(chooseDelivery({ emails: [], handles: {} })).toBe('no_contact');
    expect(channelOf('manual:linkedin')).toBe('linkedin');
    expect(channelOf('no_contact')).toBeNull();
  });
});

async function world(
  people: { name: string; status: 'idea' | 'invited' | 'confirmed'; contacted?: boolean }[],
  reach: Record<string, { emails?: string[]; handles?: Record<string, string> }>,
) {
  const repos = inMemorySpeakerRepos();
  const s = await seed(repos, people);
  // the fixture gives everyone an address: start from nobody reachable, then say how each can be
  for (const { name } of people) {
    const r = reach[name] ?? {};
    await repos.speakers.updateWithRetry(s.speakers[name] ?? '', () => ({
      emails: r.emails ?? [],
      handles: r.handles ?? {},
    }));
  }
  return { repos, s, h: buildSpeakersHarness(repos) };
}
const tasksOf = async (repos: ReturnType<typeof inMemorySpeakerRepos>) =>
  await allPages((after) => repos.tasks.findMany({ limit: 200, ...(after ? { after } : {}) }));

describe('delivery follows what we know about the speaker NOW', () => {
  it('a speaker with only a linkedin handle at T-6w: a draft on linkedin, a send task, no email', async () => {
    const { repos, s, h } = await world([{ name: 'Ana Pires', status: 'idea' }], {
      'Ana Pires': { handles: { linkedin: 'https://linkedin.com/in/ana-pires' } },
    });
    await h.service.run(s.eventId, { now: day('2026-10-31') });
    const msgs = await eventMessages(h, s.eventId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'invitation', channel: 'linkedin', status: 'draft' });
    expect(msgs.some((m) => m.channel === 'email')).toBe(false);
    expect((await tasksOf(repos)).map((t) => t.title)).toEqual(['Send to Ana Pires on linkedin']);
    // a second run the same day writes nothing twice
    await h.service.run(s.eventId, { now: day('2026-10-31') });
    expect(await tasksOf(repos)).toHaveLength(1);
  });

  it('an email speaker still gets an email draft and no send task', async () => {
    const { repos, s, h } = await world([{ name: 'Ana Pires', status: 'idea' }], {
      'Ana Pires': { emails: ['ana@speakers.invalid'] },
    });
    await h.service.run(s.eventId, { now: day('2026-10-31') });
    expect((await eventMessages(h, s.eventId)).map((m) => m.channel)).toEqual(['email']);
    expect(await tasksOf(repos)).toEqual([]);
  });

  it('a speaker with neither gets one task and no draft, and never starves the others of the cap', async () => {
    const { repos, s, h } = await world(
      [
        { name: 'Ana Pires', status: 'idea' },
        { name: 'Rui Alves', status: 'idea' },
      ],
      { 'Rui Alves': { emails: ['rui@speakers.invalid'] } },
    );
    const capped = buildSpeakersHarness(repos, {
      policy: { chaseMaxRounds: 2, chaseMinIntervalDays: 7, maxDraftsPerRun: 1 },
    });
    await capped.service.run(s.eventId, { now: day('2026-10-31') });
    await capped.service.run(s.eventId, { now: day('2026-10-31') });
    const msgs = await eventMessages(h, s.eventId);
    expect(msgs.map((m) => m.speakerId)).toEqual([s.speakers['Rui Alves']]);
    expect((await tasksOf(repos)).map((t) => t.title)).toEqual([
      'Find contact details for Ana Pires',
    ]);
  });

  it('adopting an address turns the next action into an email draft', async () => {
    const { s, h } = await world([{ name: 'Ana Pires', status: 'invited' }], {
      'Ana Pires': { handles: { linkedin: 'ana-pires' } },
    });
    const id = s.speakers['Ana Pires'] ?? '';
    // the invitation went out on LinkedIn, recorded by hand
    const rec = await h.service.recordSent(
      {
        eventId: s.eventId,
        speakerId: id,
        kind: 'invitation',
        on: '2026-11-01',
        by: 'me',
      },
      day('2026-11-02'),
    );
    expect(rec.message.channel).toBe('linkedin');
    await h.service.run(s.eventId, { now: day('2026-11-09') });
    expect(
      (await eventMessages(h, s.eventId)).filter((m) => m.kind === 'chase_reply'),
    ).toMatchObject([{ channel: 'linkedin', status: 'draft' }]);
    // a reply arrives by email and the address is adopted (what `inbox link --adopt-address` does)
    const other = await world([{ name: 'Ana Pires', status: 'invited' }], {
      'Ana Pires': { emails: ['ana@speakers.invalid'], handles: { linkedin: 'ana-pires' } },
    });
    await other.h.service.recordSent(
      {
        eventId: other.s.eventId,
        speakerId: other.s.speakers['Ana Pires'] ?? '',
        kind: 'invitation',
        on: '2026-11-01',
        by: 'me',
      },
      day('2026-11-02'),
    );
    await other.h.service.run(other.s.eventId, { now: day('2026-11-09') });
    expect(
      (await eventMessages(other.h, other.s.eventId))
        .filter((m) => m.kind === 'chase_reply')
        .map((m) => m.channel),
    ).toEqual(['email']);
  });

  it('chase limits hold on the manual path: rounds, then a call task, never an endless loop', async () => {
    const { repos, s, h } = await world([{ name: 'Ana Pires', status: 'invited' }], {
      'Ana Pires': { handles: { whatsapp: '+351000000000' } },
    });
    const id = s.speakers['Ana Pires'] ?? '';
    const sent = (kind: 'invitation' | 'chase_reply', on: string) =>
      h.service.recordSent(
        { eventId: s.eventId, speakerId: id, kind, on, by: 'me' },
        day('2026-12-01'),
      );
    await sent('invitation', '2026-11-01');
    await sent('chase_reply', '2026-11-09');
    await sent('chase_reply', '2026-11-16');
    const before = (await eventMessages(h, s.eventId)).length;
    await h.service.run(s.eventId, { now: day('2026-11-24') });
    expect((await eventMessages(h, s.eventId)).length).toBe(before); // no third chase drafted
    expect((await tasksOf(repos)).map((t) => t.title)).toEqual([
      expect.stringContaining('Call Ana Pires'),
    ]);
  });

  it('marking a manual draft sent closes its send task', async () => {
    const { repos, s, h } = await world(
      [{ name: 'Ana Pires', status: 'confirmed', contacted: true }],
      {
        'Ana Pires': { handles: { linkedin: 'ana-pires' } },
      },
    );
    await h.service.run(s.eventId, { now: day('2026-11-14') });
    const [m] = await eventMessages(h, s.eventId);
    expect(m?.channel).toBe('linkedin');
    expect((await tasksOf(repos))[0]?.status).toBe('open');
    await h.service.sent(m?._id ?? '', 'me', day('2026-11-14'));
    expect((await tasksOf(repos))[0]?.status).toBe('done');
  });
});

describe('inbox link --adopt-address', () => {
  const msg: FixtureMessage = {
    id: 'm1',
    threadId: 't1',
    labels: ['Label_1'],
    receivedAt: '2026-10-30T09:00:00.000Z',
    from: 'Ana <ana@speakers.invalid>',
    to: 'organiser@mug.invalid',
    subject: 'Re: talk',
    messageId: '<m1@speakers.invalid>',
    body: 'Hello',
    attachments: [],
  };

  async function setup() {
    const gmail = FakeGmail.empty();
    gmail.receive(msg);
    const h = buildInboxHarness({ gmail });
    const event = await h.repos.events.insert({
      title: 'Meetup',
      phase: 'planning',
      date: '2026-12-12T00:00:00.000Z',
      coHostOrganisationIds: [],
      agenda: [],
    });
    const ana = await h.repos.speakers.insert({
      name: 'Ana Pires',
      emails: [],
      handles: { linkedin: 'ana-pires' },
      topics: [],
      links: {},
      perEvent: [{ eventId: event._id, status: 'invited', updatedAt: '2026-10-01T00:00:00.000Z' }],
    });
    await h.service.poll({ now: new Date('2026-11-01T12:00:00Z') });
    const stored = await h.repos.inbound.findByGmailId('m1');
    return { h, event, ana, messageId: stored?._id ?? '' };
  }

  it('records the sender address only with the flag', async () => {
    const { h, event, ana, messageId } = await setup();
    await h.service.link(messageId, ana._id, event._id);
    expect((await h.repos.speakers.findById(ana._id))?.emails).toEqual([]);
    const r = await h.service.link(messageId, ana._id, event._id, { adoptAddress: true });
    expect(r.adoptedAddress).toBe('ana@speakers.invalid');
    expect((await h.repos.speakers.findById(ana._id))?.emails).toEqual(['ana@speakers.invalid']);
    expect((await h.repos.speakers.findByEmail('ANA@speakers.invalid'))?._id).toBe(ana._id);
    // idempotent
    expect(
      (await h.service.link(messageId, ana._id, event._id, { adoptAddress: true })).adoptedAddress,
    ).toBeUndefined();
  });

  it('refuses an address that already belongs to another speaker', async () => {
    const { h, event, ana, messageId } = await setup();
    await h.repos.speakers.insert({
      name: 'Rui',
      emails: ['ana@speakers.invalid'],
      handles: {},
      topics: [],
      links: {},
      perEvent: [],
    });
    await expect(
      h.service.link(messageId, ana._id, event._id, { adoptAddress: true }),
    ).rejects.toThrow(InboxInputError);
    expect((await h.repos.speakers.findById(ana._id))?.emails).toEqual([]);
  });
});
