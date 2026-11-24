import { describe, expect, it } from 'vitest';
import { decodeEntities, normaliseBody } from '../../src/inbox/normalise.js';
import { FakeGmail, type FixtureMessage } from '../support/fake-gmail.js';
import { buildInboxHarness } from '../support/inbox-harness.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');

/** What a marketing mail looks like: the content is three lines, the rest is padding. */
const PAD = '&#8199;&#847; &shy;'.repeat(300);
const MARKETING = `Your registration is confirmed.${PAD}\n\n\n\nSee you at the meetup &amp; bring a friend.${PAD}\nTable:   Name  |   Seats\t\t\tAda | 4 ${PAD}`;

describe('normaliseBody (pure)', () => {
  it('decodes entities, strips invisible padding, collapses whitespace', () => {
    const n = normaliseBody(MARKETING, 20_000);
    expect(n.text).toBe(
      'Your registration is confirmed.\n\nSee you at the meetup & bring a friend.\nTable: Name | Seats Ada | 4',
    );
    expect(n.truncated).toBe(false);
    expect(MARKETING.length).toBeGreaterThan(8000); // about 8KB for 3 lines of content
    expect(n.text.length).toBeLessThan(120);
  });

  it('decodes once only (no double decoding) and leaves unknown entities and a bare ampersand alone', () => {
    expect(decodeEntities('&amp;lt; &unknownthing; AT&T &#x41;&#66;')).toBe(
      '&lt; &unknownthing; AT&T AB',
    );
    expect(decodeEntities('&#0; &#55296; &#1114112;')).toBe('  '); // invalid code points vanish
  });

  it('removes zero-width characters and the soft hyphen, and maps exotic spaces to a plain one', () => {
    expect(normaliseBody('a​b­c͏d﻿e f g　h', 100).text).toBe('abcde f g h');
  });

  it('caps the stored body and says it did', () => {
    const n = normaliseBody('x'.repeat(50), 20);
    expect(n).toEqual({ text: 'x'.repeat(20), truncated: true });
    expect(normaliseBody('x'.repeat(20), 20).truncated).toBe(false);
  });

  it('is idempotent', () => {
    const once = normaliseBody(MARKETING, 20_000).text;
    expect(normaliseBody(once, 20_000).text).toBe(once);
  });

  it('keeps ordinary text exactly, line structure included', () => {
    const t = 'Hi Ana,\n\nCan you speak on 12 December?\n\nThanks,\nVlad';
    expect(normaliseBody(t, 1000).text).toBe(t);
  });
});

const msg = (
  over: Partial<FixtureMessage> & Pick<FixtureMessage, 'id' | 'threadId'>,
): FixtureMessage => ({
  labels: ['Label_1'],
  receivedAt: '2026-10-30T09:00:00.000Z',
  from: 'Meetup <info@people.invalid>',
  to: 'organiser@mug.invalid',
  subject: `Subject ${over.id}`,
  messageId: `<${over.id}@people.invalid>`,
  body: 'Body',
  attachments: [],
  ...over,
});

describe('ingestion normalises NEW messages', () => {
  it('stores the normalised body, records whether it was cut, and the model gets the short text', async () => {
    const gmail = FakeGmail.empty();
    gmail.receive(msg({ id: 'm1', threadId: 't1', body: MARKETING }));
    gmail.receive(msg({ id: 'm2', threadId: 't2', body: `${'long '.repeat(100)}end` }));
    const h = buildInboxHarness({ gmail, config: { bodyMaxChars: 200 } });
    await h.service.poll({ now: NOW });
    const one = await h.repos.inbound.findByGmailId('m1');
    expect(await h.repos.inbound.getRawBody(one?._id ?? '')).toMatch(
      /^Your registration is confirmed\./,
    );
    expect(await h.repos.inbound.getRawBody(one?._id ?? '')).not.toMatch(/&#|&shy|͏/);
    expect(one?.bodyTruncated).toBe(false);
    const two = await h.repos.inbound.findByGmailId('m2');
    expect((await h.repos.inbound.getRawBody(two?._id ?? ''))?.length).toBeLessThanOrEqual(200);
    expect((await h.repos.inbound.getRawBody(two?._id ?? ''))?.length).toBeGreaterThan(190);
    expect(two?.bodyTruncated).toBe(true);
    for (const p of h.model.prompts) expect(p).not.toMatch(/&#8199;|&shy;/);
  });
});

describe('repair-bodies: opt-in, and a dry run by default', () => {
  async function legacy() {
    const gmail = FakeGmail.empty();
    gmail.receive(msg({ id: 'a', threadId: 't1', body: 'Plain and fine.' }));
    gmail.receive(msg({ id: 'b', threadId: 't2', body: 'placeholder b' }));
    gmail.receive(msg({ id: 'c', threadId: 't3', body: 'placeholder c' }));
    const h = buildInboxHarness({ gmail });
    await h.service.poll({ now: NOW });
    // two messages stored BEFORE normalisation existed: padded, and one with a bad stored body
    const ids: Record<string, string> = {};
    for (const g of ['a', 'b', 'c']) ids[g] = (await h.repos.inbound.findByGmailId(g))?._id ?? '';
    const repo = h.repos.inbound as unknown as { legacyBody(id: string, t: string): void };
    repo.legacyBody(ids['b'] ?? '', MARKETING);
    repo.legacyBody(ids['c'] ?? '', 'undefined\r\n');
    return { h, ids };
  }
  const snapshot = async (
    h: Awaited<ReturnType<typeof legacy>>['h'],
    ids: Record<string, string>,
  ) =>
    JSON.stringify([
      await Promise.all(Object.values(ids).map((i) => h.repos.inbound.getRawBody(i))),
      await Promise.all(Object.values(ids).map((i) => h.repos.inbound.findById(i))),
    ]);

  it('the default is a DRY RUN: it reports what it would change and changes nothing', async () => {
    const { h, ids } = await legacy();
    const before = await snapshot(h, ids);
    const r = await h.service.repairBodies();
    expect(r).toMatchObject({
      written: false,
      considered: 3,
      wouldChange: 1,
      alreadyNormalised: 1,
      leftAloneBadBody: 1,
    });
    expect(r.charsRemoved).toBeGreaterThan(8000);
    expect(await snapshot(h, ids)).toBe(before); // byte-for-byte unchanged
  });

  it('--write is required to change anything; then only the body and what derives from it change, and a second run does nothing', async () => {
    const { h, ids } = await legacy();
    const triageBefore = JSON.stringify((await h.repos.inbound.findById(ids['b'] ?? ''))?.triage);
    const r = await h.service.repairBodies({ write: true });
    expect(r).toMatchObject({ written: true, wouldChange: 1 });
    const b = await h.repos.inbound.findById(ids['b'] ?? '');
    expect(await h.repos.inbound.getRawBody(ids['b'] ?? '')).toMatch(
      /^Your registration is confirmed\./,
    );
    expect(b?.bodyTruncated).toBe(false);
    expect(b?.bodyRedacted).toContain('registration');
    expect(JSON.stringify(b?.triage)).toBe(triageBefore); // the triage result is not touched
    // the plain message and the bad one are untouched
    expect(await h.repos.inbound.getRawBody(ids['a'] ?? '')).toBe('Plain and fine.');
    expect(await h.repos.inbound.getRawBody(ids['c'] ?? '')).toBe('undefined\r\n');
    const again = await h.service.repairBodies({ write: true });
    expect(again).toMatchObject({ wouldChange: 0, alreadyNormalised: 2, leftAloneBadBody: 1 });
  });
});
