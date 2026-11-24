import { describe, expect, it } from 'vitest';
import { classify, parseSenderList, ruleSummary, senderOnList } from '../../src/inbox/rules.js';
import { formatPollReport } from '../../src/inbox/format.js';
import { renderValidation, validateRules } from '../../src/inbox/rule-validation.js';
import { FakeGmail, type FixtureMessage } from '../support/fake-gmail.js';
import { NEUTRAL_ANSWER, buildInboxHarness } from '../support/inbox-harness.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const SHARE = ['drive-shares-dm-noreply@google.com', '@docs.example'];

describe('classify (pure)', () => {
  const base = { fromAddress: 'x@y.invalid', isSpeaker: false };

  it('sends an unknown sender with no signal to the model, for everything', () => {
    expect(classify(base, SHARE)).toEqual({ verdict: { mode: 'model' }, overridden: [] });
  });

  it('decides by header and sender facts with no model', () => {
    expect(classify({ ...base, listUnsubscribe: '<mailto:u@x>' }, SHARE).verdict).toEqual({
      mode: 'rule',
      intent: 'newsletter_or_noise',
      decidedBy: 'rule_list_unsubscribe',
    });
    expect(classify({ ...base, hasCalendarPart: true }, SHARE).verdict).toMatchObject({
      mode: 'rule',
      intent: 'calendar_invite',
    });
    expect(
      classify({ ...base, fromAddress: 'Drive-Shares-DM-NoReply@google.com' }, SHARE).verdict,
    ).toMatchObject({ mode: 'rule', intent: 'document_share', decidedBy: 'rule_sender_list' });
    expect(classify({ ...base, fromAddress: 'a@docs.example' }, SHARE).verdict).toMatchObject({
      intent: 'document_share',
    });
  });

  it('a known sender fixes the intent and still asks the model, except role noise', () => {
    expect(classify({ ...base, contactRole: 'cohost' }, SHARE).verdict).toEqual({
      mode: 'fixed-intent',
      intent: 'cohost_reply',
      decidedBy: 'lookup_contact',
    });
    expect(classify({ ...base, isSpeaker: true }, SHARE).verdict).toMatchObject({
      mode: 'fixed-intent',
      intent: 'speaker_reply',
      decidedBy: 'lookup_speaker',
    });
    expect(classify({ ...base, contactRole: 'noise' }, SHARE).verdict).toMatchObject({
      mode: 'rule',
      intent: 'newsletter_or_noise',
    });
  });

  it('role platform: the intent is platform_notification, decided by lookup, with NO model call', () => {
    expect(classify({ ...base, contactRole: 'platform' }, SHARE).verdict).toEqual({
      mode: 'rule',
      intent: 'platform_notification',
      decidedBy: 'lookup_contact',
    });
  });

  it('a contact role beats a speaker match; a lookup beats a rule; the disagreement is reported', () => {
    const r = classify(
      {
        ...base,
        isSpeaker: true,
        contactRole: 'coorganiser',
        listUnsubscribe: 'x',
        hasCalendarPart: true,
      },
      SHARE,
    );
    expect(r.verdict).toMatchObject({ intent: 'coorganiser', decidedBy: 'lookup_contact' });
    expect(r.overridden.map((c) => c.decidedBy)).toEqual([
      'rule_calendar',
      'rule_list_unsubscribe',
    ]);
    // agreeing deciders are not conflicts
    expect(
      classify({ ...base, contactRole: 'noise', listUnsubscribe: 'x' }, SHARE).overridden,
    ).toEqual([]);
  });

  it('parses sender lists', () => {
    expect(parseSenderList(' A@b.c, @D.e;f@g.h ')).toEqual(['a@b.c', '@d.e', 'f@g.h']);
    expect(senderOnList('x@d.e', ['@d.e'])).toBe(true);
    expect(senderOnList('x@sub.d.e', ['@d.e'])).toBe(false);
  });

  it('a rule summary claims nothing it did not see', () => {
    const s = ruleSummary('calendar_invite', 'rule_calendar');
    expect(s).toMatchObject({
      model: 'none',
      needs_human: false,
      sentiment_decision: 'unclear',
      asks: [],
      decidedBy: 'rule_calendar',
    });
  });
});

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

function harnessWith(...messages: FixtureMessage[]) {
  const gmail = FakeGmail.empty();
  for (const m of messages) gmail.receive(m);
  return buildInboxHarness({ gmail });
}

describe('poll routes before it asks a model', () => {
  it('a List-Unsubscribe, a calendar part and a document-share sender never reach the model', async () => {
    const h = harnessWith(
      msg({ id: 'n1', threadId: 't1', listUnsubscribe: '<https://x.invalid/unsub>' }),
      msg({ id: 'c1', threadId: 't2', hasCalendarPart: true }),
      msg({ id: 'd1', threadId: 't3', from: 'Drive <drive-shares-dm-noreply@google.com>' }),
      msg({ id: 'u1', threadId: 't4' }),
    );
    const r = await h.service.poll({ now: NOW });
    expect(h.model.prompts).toHaveLength(1); // only the unknown sender
    expect(r.reachedModel).toBe(1);
    expect(r.decidedBy).toMatchObject({
      rule_list_unsubscribe: 1,
      rule_calendar: 1,
      rule_sender_list: 1,
      model: 1,
    });
    const intent = async (id: string) => (await h.repos.inbound.findByGmailId(id))?.triage;
    expect(await intent('n1')).toMatchObject({ intent: 'newsletter_or_noise', model: 'none' });
    expect(await intent('c1')).toMatchObject({ intent: 'calendar_invite', model: 'none' });
    expect(await intent('d1')).toMatchObject({ intent: 'document_share', model: 'none' });
    expect(await intent('u1')).toMatchObject({ intent: 'other', decidedBy: 'model' });
    // The structure was stored, so a later audit can see why.
    expect(await h.repos.inbound.findByGmailId('n1')).toMatchObject({
      listUnsubscribe: '<https://x.invalid/unsub>',
      hasCalendarPart: false,
    });
  });

  it('a known contact fixes the intent; the model is not asked for it and cannot override it', async () => {
    const h = harnessWith(msg({ id: 'k1', threadId: 't1', from: 'Co <host@partner.invalid>' }));
    await h.service.setContactRole('host@partner.invalid', 'cohost', 'test');
    // the model disobeys and answers with an intent: ignored, never stored
    h.model.queue = [() => NEUTRAL_ANSWER.replace('"other"', '"venue_reply"')];
    const r = await h.service.poll({ now: NOW });
    expect(h.model.prompts).toHaveLength(1);
    expect(h.model.prompts[0]).toContain('Do NOT output an intent field');
    expect(r.decidedBy.lookup_contact).toBe(1);
    expect((await h.repos.inbound.findByGmailId('k1'))?.triage).toMatchObject({
      intent: 'cohost_reply',
      decidedBy: 'lookup_contact',
      model: 'ollama:stub-triage',
    });
  });

  it('role noise from a known sender needs no model at all', async () => {
    const h = harnessWith(msg({ id: 'z1', threadId: 't1', from: 'Bot <bot@vendor.invalid>' }));
    await h.service.setContactRole('bot@vendor.invalid', 'noise', 'test');
    await h.service.poll({ now: NOW });
    expect(h.model.prompts).toHaveLength(0);
  });

  it('a lookup and a rule that disagree: the lookup wins, and the disagreement is counted', async () => {
    const h = harnessWith(
      msg({ id: 'k1', threadId: 't1', from: 'Org <org@mug.invalid>', listUnsubscribe: '<x>' }),
    );
    await h.service.setContactRole('org@mug.invalid', 'coorganiser', 'test');
    const r = await h.service.poll({ now: NOW });
    expect(r.ruleConflicts).toBe(1);
    expect((await h.repos.inbound.findByGmailId('k1'))?.triage?.intent).toBe('coorganiser');
  });

  it('a sender list entry in config is honoured', async () => {
    const h = buildInboxHarness({
      gmail: (() => {
        const g = FakeGmail.empty();
        g.receive(msg({ id: 'd1', threadId: 't1', from: 'X <notify@docs.example>' }));
        return g;
      })(),
      config: { documentShareSenders: ['@docs.example'] },
    });
    await h.service.poll({ now: NOW });
    expect(h.model.prompts).toHaveLength(0);
  });
});

describe('retriage and backfill', () => {
  it('re-triages stored messages with the new rules, raising no tasks', async () => {
    const h = harnessWith(msg({ id: 'n1', threadId: 't1', from: 'Org <org@mug.invalid>' }));
    await h.service.poll({ now: NOW });
    expect((await h.repos.inbound.findByGmailId('n1'))?.triage?.intent).toBe('other');
    await h.service.setContactRole('org@mug.invalid', 'coorganiser', 'test');
    h.model.prompts.length = 0;
    const r = await h.service.retriage();
    expect(r.considered).toBe(1);
    expect((await h.repos.inbound.findByGmailId('n1'))?.triage?.intent).toBe('coorganiser');
  });

  it('backfills structure for messages stored before it was read, reading no body', async () => {
    const h = harnessWith(
      msg({ id: 'n1', threadId: 't1', listUnsubscribe: '<x>' }),
      msg({ id: 'c1', threadId: 't2', hasCalendarPart: true }),
      msg({ id: 'p1', threadId: 't3' }),
    );
    await h.service.poll({ now: NOW });
    // simulate messages stored before the structure existed
    for (const m of await h.repos.inbound.findRecent(10)) h.repos.inbound.clearStructure(m._id);
    expect((await h.repos.inbound.findByGmailId('n1'))?.structureCheckedAt).toBeUndefined();
    const fullBefore = h.gmail.calls.full.length;
    const r = await h.service.backfillStructure();
    expect(r).toMatchObject({
      needed: 3,
      checked: 3,
      withListUnsubscribe: 1,
      withCalendarPart: 1,
      notFound: 0,
    });
    expect(h.gmail.calls.full.length).toBe(fullBefore); // no body fetched
    expect(await h.repos.inbound.findByGmailId('n1')).toMatchObject({ listUnsubscribe: '<x>' });
    expect((await h.repos.inbound.findByGmailId('c1'))?.hasCalendarPart).toBe(true);
    expect((await h.service.backfillStructure()).needed).toBe(0);
  });
});

describe('validateRules', () => {
  it('reports each rule-vs-model disagreement and judges nothing it cannot', async () => {
    const h = harnessWith(
      msg({ id: 'a1', threadId: 't1', from: 'L <list@news.invalid>', listUnsubscribe: '<x>' }),
      msg({ id: 'a2', threadId: 't2', from: 'L <list@news.invalid>', listUnsubscribe: '<x>' }),
      msg({ id: 'b1', threadId: 't3', from: 'P <pal@people.invalid>', listUnsubscribe: '<x>' }),
      msg({ id: 'c1', threadId: 't4', from: 'M <m@mixed.invalid>' }),
      msg({ id: 'c2', threadId: 't5', from: 'M <m@mixed.invalid>' }),
    );
    // the model (not the rules) triaged these: make every stored verdict the model's
    h.model.queue = [];
    await h.service.poll({ now: NOW });
    const noise = (id: string, intent: string) => {
      h.repos.inbound.forceIntent(id, intent);
    };
    noise('a1', 'newsletter_or_noise');
    noise('a2', 'newsletter_or_noise');
    noise('b1', 'other'); // the model said other, the header rule says noise: a disagreement
    noise('c1', 'newsletter_or_noise'); // no rule matches
    noise('c2', 'speaker_reply');
    const report = validateRules(await h.service.validationInputs());
    expect(report.modelNoise).toBe(3);
    expect(report.noiseVerdicts).toMatchObject({
      caughtAsNoise: 2,
      notCaught: 1,
      ruleSaysOther: 0,
    });
    expect(report.disagreements.map((d) => d.gmailId)).toEqual(['b1']);
    const mixed = report.senders.find((s) => s.sender === 'm@mixed.invalid');
    expect(mixed?.senderRuleSafe).toBe(false);
    expect(report.senders.find((s) => s.sender === 'list@news.invalid')).toMatchObject({
      senderRuleSafe: true,
      allHaveListUnsubscribe: true,
    });
    expect(renderValidation(report)).toContain('Every disagreement (1)');
  });
});

describe('platform mail (Meetup, Luma, Slack): kept, cheap, and never correspondence', () => {
  const PLATFORM = 'Meetup <info@meetup.invalid>';

  it('is decided by lookup with no model call, even with List-Unsubscribe and a calendar part, and counted per sender', async () => {
    const h = harnessWith(
      msg({
        id: 'p1',
        threadId: 't1',
        from: PLATFORM,
        listUnsubscribe: '<x>',
        subject: '3 new RSVPs',
      }),
      msg({ id: 'p2', threadId: 't2', from: PLATFORM, hasCalendarPart: true }),
      msg({ id: 'p3', threadId: 't3', from: 'Luma <notify@luma.invalid>' }),
      msg({ id: 'u1', threadId: 't4' }),
    );
    for (const a of ['info@meetup.invalid', 'notify@luma.invalid'])
      await h.service.setContactRole(a, 'platform', 'test');
    const r = await h.service.poll({ now: NOW });
    expect(h.model.prompts).toHaveLength(1); // only the unknown sender
    for (const id of ['p1', 'p2', 'p3']) {
      expect((await h.repos.inbound.findByGmailId(id))?.triage).toMatchObject({
        intent: 'platform_notification',
        decidedBy: 'lookup_contact',
        model: 'none',
      });
    }
    // Kept: stored in full, not discarded like noise.
    expect(
      await h.repos.inbound.getRawBody((await h.repos.inbound.findByGmailId('p1'))?._id ?? ''),
    ).toContain('Body of p1');
    expect(r.platform).toEqual({ 'info@meetup.invalid': 2, 'notify@luma.invalid': 1 });
  });

  it('raises no task, links to no speaker, and never moves lastInboundAt (so it cannot pause a chase)', async () => {
    const h = harnessWith(
      msg({
        id: 'a1',
        threadId: 'th-ana',
        from: 'Ana <ana@speakers.invalid>',
        receivedAt: '2026-10-28T09:00:00.000Z',
      }),
      // a Slack relay lands in the speaker's own thread, later: still not hers
      msg({
        id: 'p1',
        threadId: 'th-ana',
        from: 'Slack <notify@slack.invalid>',
        receivedAt: '2026-10-30T09:00:00.000Z',
      }),
    );
    await h.service.setContactRole('notify@slack.invalid', 'platform', 'test');
    const event = await h.repos.events.insert({
      title: 'Meetup',
      phase: 'planning',
      date: '2026-12-12T00:00:00.000Z',
      coHostOrganisationIds: [],
      agenda: [],
    });
    const ana = await h.repos.speakers.insert({
      name: 'Ana',
      emails: ['ana@speakers.invalid'],
      handles: {},
      topics: [],
      links: {},
      perEvent: [{ eventId: event._id, status: 'invited', updatedAt: '2026-10-01T00:00:00.000Z' }],
    });
    await h.service.poll({ now: NOW });
    const p = await h.repos.inbound.findByGmailId('p1');
    expect(p?.linkState).toBe('unlinked');
    expect(p?.linkedSpeakerId).toBeUndefined();
    // Her own message set it; the later platform message did not move it.
    expect((await h.repos.speakers.findById(ana._id))?.perEvent[0]?.lastInboundAt).toBe(
      '2026-10-28T09:00:00.000Z',
    );
    expect((await h.repos.tasks.findMany({ limit: 50 })).items).toEqual([]);
    // And no contact was written as "replied to us".
    expect((await h.repos.contacts.findByAddress('notify@slack.invalid'))?.source).toBe(
      'added_by_human',
    );
  });

  it('even a model that calls an unknown sender platform_notification and asks for a human raises no task', async () => {
    const h = harnessWith(
      msg({ id: 'u1', threadId: 't1', from: 'New <hello@newplatform.invalid>' }),
    );
    h.model.queue = [
      () =>
        JSON.stringify({
          ...JSON.parse(NEUTRAL_ANSWER),
          intent: 'platform_notification',
          needs_human: true,
          reason: 'looks important',
        }),
    ];
    await h.service.poll({ now: NOW });
    expect((await h.repos.inbound.findByGmailId('u1'))?.triage?.intent).toBe(
      'platform_notification',
    );
    expect((await h.repos.tasks.findMany({ limit: 50 })).items).toEqual([]);
  });

  it('the poll output shows the volume per sender, and nothing when there is none', async () => {
    const h = harnessWith(
      msg({ id: 'p1', threadId: 't1', from: PLATFORM }),
      msg({ id: 'p2', threadId: 't2', from: PLATFORM }),
      msg({ id: 'p3', threadId: 't3', from: 'Luma <notify@luma.invalid>' }),
    );
    for (const a of ['info@meetup.invalid', 'notify@luma.invalid'])
      await h.service.setContactRole(a, 'platform', 'test');
    const text = formatPollReport(await h.service.poll({ now: NOW }), {
      dryRun: false,
      label: 'x',
    }).join('\n');
    expect(text).toContain('Platform mail');
    expect(text).toContain(': 3: info@meetup.invalid 2, notify@luma.invalid 1.');
    const none = buildInboxHarness();
    expect(
      formatPollReport(await none.service.poll({ now: NOW }), { dryRun: false, label: 'x' }).join(
        '\n',
      ),
    ).not.toContain('Platform mail');
  });
});
