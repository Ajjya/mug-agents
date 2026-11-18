import { describe, expect, it } from 'vitest';
import { type FixtureMessage, FakeGmail } from '../support/fake-gmail.js';
import { type InboxHarness, buildInboxHarness } from '../support/inbox-harness.js';

/**
 * SPEC 1 IS THE MILESTONE'S SECURITY CONTROL. The mailbox is the organiser's personal one, and Gmail's
 * read scope is all-or-nothing, so what the system reads is decided HERE and nowhere else. These tests
 * count what happened at the boundaries (which ids had a body fetched, how many times a model was
 * called, what text each call carried), not just what ended up in a collection: a private message
 * that reached a provider and was then "not stored" would still be the failure this must prevent.
 *
 * Fixture mailbox (test/fixtures/gmail/mailbox.json):
 *   labelled mug-agents:  m-001 (th-001), m-005 (th-005)
 *   unlabelled, in an admitted thread: m-006 (a later reply in th-001)
 *   candidate only (mug-maybe): m-004 (th-004)
 *   PRIVATE, unlabelled: m-002 bank, m-003 job, m-008 medical; m-007 an old unlabelled mail
 */

const PRIVATE = ['m-002', 'm-003', 'm-008'];
const IN_SCOPE_FIRST_POLL = ['m-001', 'm-005', 'm-006'];
const NOW = new Date('2026-11-01T12:00:00.000Z');

const message = (
  over: Partial<FixtureMessage> & Pick<FixtureMessage, 'id' | 'threadId'>,
): FixtureMessage => ({
  labels: ['INBOX'],
  receivedAt: '2026-10-30T09:00:00.000Z',
  from: 'Someone <someone@people.invalid>',
  to: 'organiser@mug.invalid',
  subject: `Subject ${over.id}`,
  messageId: `<${over.id}@people.invalid>`,
  body: `Body of ${over.id}`,
  attachments: [],
  ...over,
});

async function storedEverything(h: InboxHarness): Promise<string> {
  const views = await h.repos.inbound.findRecent(1000);
  const bodies = await Promise.all(views.map((v) => h.repos.inbound.getRawBody(v._id)));
  return JSON.stringify({
    views,
    bodies,
    candidates: (await h.repos.candidates.findMany({ limit: 200 })).items,
    admitted: (await h.repos.admitted.findMany({ limit: 200 })).items,
    contacts: (await h.repos.contacts.findMany({ limit: 200 })).items,
    tasks: (await h.repos.tasks.findMany({ limit: 200 })).items,
  });
}

/** The invariant, asserted after every scenario below. */
async function expectNothingPrivateLeft(h: InboxHarness, privateIds: readonly string[] = PRIVATE) {
  const everything = await storedEverything(h);
  expect(everything).not.toContain('PRIVATE-MARKER');
  expect(h.model.prompts.join('\n')).not.toContain('PRIVATE-MARKER');
  for (const id of privateIds) {
    expect(h.gmail.calls.full, `body of ${id} fetched`).not.toContain(id);
    expect(await h.repos.inbound.findByGmailId(id), `${id} stored`).toBeNull();
  }
  // Counts only, never a subject or an address, when something is dropped.
  const logs = h.logs.join('\n');
  expect(logs).not.toMatch(/PRIVATE-MARKER|bank\.invalid|employer\.invalid|clinic\.invalid/);
}

describe('1.2 / 1.3 the query path: only what the label (or an admitted thread) covers', () => {
  it('stores and triages exactly the in-scope mail; no private body is fetched, none reaches a model', async () => {
    const h = buildInboxHarness();
    const report = await h.service.poll({ now: NOW });

    expect([...report.stored].sort()).toEqual(IN_SCOPE_FIRST_POLL);
    // COUNTED: bodies fetched, and model calls: one each for the three in-scope messages, no more.
    expect([...h.gmail.calls.full].sort()).toEqual(IN_SCOPE_FIRST_POLL);
    expect(h.model.calls).toBe(3);
    // Every listing was scoped by a label id (the transport cannot express an unscoped list).
    expect(h.gmail.calls.list.length).toBeGreaterThan(0);
    expect(
      h.gmail.calls.list.every((q) => q.labelId === 'Label_1' || q.labelId === 'Label_2'),
    ).toBe(true);
    // The private messages were never even listed, so their headers were never read.
    for (const id of PRIVATE) expect(h.gmail.calls.metadata).not.toContain(id);
    await expectNothingPrivateLeft(h);
  });

  it('a second poll over the same mailbox creates nothing, fetches no body, calls no model', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    const full = [...h.gmail.calls.full];
    const modelCalls = h.model.calls;
    const second = await h.service.poll({ now: NOW });
    expect(second.stored).toEqual([]);
    expect(second.alreadyStored).toBeGreaterThanOrEqual(3);
    expect(h.gmail.calls.full).toEqual(full);
    expect(h.model.calls).toBe(modelCalls);
    expect(await h.repos.inbound.count()).toBe(3);
  });
});

describe('1.3 belt and braces: a WRONG query still cannot store or send a private message', () => {
  it('when the listing ignores the label and returns the whole mailbox', async () => {
    const h = buildInboxHarness();
    h.gmail.ignoreLabelScope = true; // simulates one typo in the query: every message comes back
    const report = await h.service.poll({ now: NOW });

    expect([...report.stored].sort()).toEqual(IN_SCOPE_FIRST_POLL);
    expect(report.dropped).toBeGreaterThanOrEqual(PRIVATE.length);
    // Headers of private mail may be read in this case (the label is only knowable from them), but
    // the BODY is not fetched, nothing is stored and no model is called for them: counted.
    expect([...h.gmail.calls.full].sort()).toEqual(IN_SCOPE_FIRST_POLL);
    expect(h.model.calls).toBe(3);
    await expectNothingPrivateLeft(h);
  });
});

describe('1.3 / 1.6 the history path', () => {
  it('history reports a private message; it is dropped without even reading its headers', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    const modelBefore = h.model.calls;

    // New mail arrives: a private one (unlabelled), a labelled one, and a reply in admitted th-005.
    h.gmail.receive(
      message({
        id: 'm-100',
        threadId: 'th-100',
        subject: 'PRIVATE-MARKER-NEW',
        body: 'PRIVATE-MARKER-NEW secret',
      }),
    );
    h.gmail.receive(message({ id: 'm-101', threadId: 'th-101', labels: ['INBOX', 'Label_1'] }));
    h.gmail.receive(message({ id: 'm-102', threadId: 'th-005' }));

    // The history feed DOES contain the private message: this is what must be filtered.
    const cursor = (await h.repos.cursor.get())?.historyId ?? '';
    const feed = await h.gmail.listHistory(cursor);
    expect(feed.records.map((r) => r.messageId)).toContain('m-100');

    const report = await h.service.poll({ now: NOW });
    expect(report.historyUsed).toBe(true);
    expect([...report.stored].sort()).toEqual(['m-101', 'm-102']);
    expect(h.gmail.calls.metadata).not.toContain('m-100'); // dropped on what history said, no fetch
    expect(h.gmail.calls.full).not.toContain('m-100');
    expect(h.model.calls).toBe(modelBefore + 2);
    await expectNothingPrivateLeft(h, [...PRIVATE, 'm-100']);
  });
});

describe('1.5 a lost or expired cursor degrades to a bounded backfill over the label', () => {
  it('an expired history id falls back to the label sweep, never to the whole mailbox', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    h.gmail.receive(
      message({
        id: 'm-110',
        threadId: 'th-110',
        body: 'PRIVATE-MARKER-X',
        subject: 'PRIVATE-MARKER-X',
      }),
    );
    h.gmail.receive(message({ id: 'm-111', threadId: 'th-111', labels: ['INBOX', 'Label_1'] }));
    h.gmail.expireHistory();
    const listsBefore = h.gmail.calls.list.length;

    const report = await h.service.poll({ now: NOW });
    expect(report.historyExpired).toBe(true);
    expect(report.stored).toEqual(['m-111']);
    // Everything listed was label-scoped; a label sweep, not a mailbox fetch.
    const newLists = h.gmail.calls.list.slice(listsBefore);
    expect(newLists.length).toBeGreaterThan(0);
    expect(newLists.every((q) => q.labelId.startsWith('Label_'))).toBe(true);
    expect(h.gmail.calls.full).not.toContain('m-110');
    await expectNothingPrivateLeft(h, [...PRIVATE, 'm-110']);
    // The cursor is reset to the mailbox's current id, so the next poll uses history again.
    expect((await h.repos.cursor.get())?.historyId).toBeDefined();
    expect((await h.repos.cursor.get())?.lastHistoryExpiredAt).toBeDefined();
  });

  it('the sweep is bounded: it reads at most GMAIL_SWEEP_MAX_PAGES pages per label', async () => {
    const h = buildInboxHarness({ config: { sweepMaxPages: 2 } });
    h.gmail.pageSize = 2;
    for (let i = 0; i < 12; i++) {
      h.gmail.receive(
        message({
          id: `m-2${String(i).padStart(2, '0')}`,
          threadId: `th-2${String(i).padStart(2, '0')}`,
          labels: ['INBOX', 'Label_1'],
          receivedAt: `2026-10-${String(10 + i)}T09:00:00.000Z`,
        }),
      );
    }
    const report = await h.service.poll({ now: NOW });
    const labelOne = h.gmail.calls.list.filter((q) => q.labelId === 'Label_1');
    expect(labelOne.length).toBeLessThanOrEqual(2); // 2 pages of 2, not 16 messages
    expect(report.sweepTruncated).toBe(true);
    expect(report.stored.length).toBeLessThanOrEqual(4 + 1); // at most the swept ids (+ a thread reply)
    expect(h.gmail.calls.full.length).toBeLessThan(14);
  });
});

describe('1.5 the label arrives after the message does', () => {
  it('a message received before the last poll and labelled after it is picked up', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    expect(await h.repos.inbound.findByGmailId('m-007')).toBeNull();
    expect(h.gmail.calls.full).not.toContain('m-007');

    // m-007 was received on 1 Sep, long before the poll above; the organiser labels it today.
    h.gmail.applyLabel('m-007', 'mug-agents');
    const report = await h.service.poll({ now: NOW });
    expect(report.stored).toEqual(['m-007']);
    expect(h.gmail.calls.full).toContain('m-007');
    expect(h.model.calls).toBe(4);
  });

  it('and still when the history id has expired meanwhile', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    h.gmail.applyLabel('m-007', 'mug-agents');
    h.gmail.expireHistory();
    const report = await h.service.poll({ now: NOW });
    expect(report.historyExpired).toBe(true);
    expect(report.stored).toEqual(['m-007']);
  });
});

describe('1a scope is the thread, not the message', () => {
  it('a later, unlabelled reply in an admitted thread is picked up', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    h.gmail.receive(
      message({ id: 'm-120', threadId: 'th-001', body: 'One more thing from Wendeline.' }),
    );
    const report = await h.service.poll({ now: NOW });
    expect(report.stored).toEqual(['m-120']);
    expect((await h.repos.admitted.findByThreadId('th-001'))?.admittedBy).toBe('label');
  });

  it('a reply in an excluded thread is not: nothing fetched, stored or triaged', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    await h.service.excludeThread('th-001', 'not MUG business after all');
    const modelBefore = h.model.calls;
    const fullBefore = [...h.gmail.calls.full];

    h.gmail.receive(message({ id: 'm-121', threadId: 'th-001', body: 'A reply after exclusion.' }));
    // Even a fresh label on it does not bring it back: exclusion is permanent until undone.
    h.gmail.applyLabel('m-121', 'mug-agents');
    const report = await h.service.poll({ now: NOW });

    expect(report.stored).toEqual([]);
    expect(h.gmail.calls.full).toEqual(fullBefore);
    expect(h.model.calls).toBe(modelBefore);
    expect(await h.repos.inbound.findByGmailId('m-121')).toBeNull();
    // Nothing is deleted: what was stored before the exclusion stays.
    expect(await h.repos.inbound.findByGmailId('m-001')).not.toBeNull();
  });

  it('lifting the exclusion brings the thread back, and says so in the record (nothing deleted)', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    await h.service.excludeThread('th-001', 'oops');
    h.gmail.receive(message({ id: 'm-122', threadId: 'th-001' }));
    await h.service.poll({ now: NOW });
    expect(await h.repos.inbound.findByGmailId('m-122')).toBeNull();
    await h.service.includeThread('th-001');
    expect((await h.repos.excluded.findByThreadId('th-001'))?.status).toBe('lifted');
    expect((await h.service.poll({ now: NOW })).stored).toEqual(['m-122']);
  });
});

describe('1.1 candidates: metadata only, never a body, never a model', () => {
  it('a thread that is only a candidate: no body fetched, no model call, headers recorded', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });

    expect(h.gmail.calls.full).not.toContain('m-004'); // COUNTED: no body fetch
    expect(h.model.prompts.join('\n')).not.toContain('CANDIDATE-BODY-MARKER'); // COUNTED: no model text
    expect(await h.repos.inbound.findByGmailId('m-004')).toBeNull(); // not an inbound message
    const pending = await h.service.listCandidates();
    expect(pending.map((c) => [c.threadId, c.subject, c.from.address, c.state])).toEqual([
      ['th-004', 'Database Weekly: issue 412', 'news@vendor.invalid', 'pending'],
    ]);
    expect(JSON.stringify(pending)).not.toContain('CANDIDATE-BODY-MARKER');
    expect(await storedEverything(h)).not.toContain('CANDIDATE-BODY-MARKER');
    // Seen once, not re-read every poll.
    await h.service.poll({ now: NOW });
    expect(h.gmail.calls.metadata.filter((id) => id === 'm-004')).toHaveLength(1);
  });

  it('admit makes its bodies readable; the decision is stored, not inferred from messages', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    await h.service.admit('th-004', 'vlad');

    // The decision lives in its own record; there is still no message record to infer it from.
    expect(await h.repos.admitted.findByThreadId('th-004')).toMatchObject({ admittedBy: 'human' });
    expect((await h.repos.candidates.findByThreadId('th-004'))?.state).toBe('admitted');
    expect(await h.repos.inbound.findByGmailId('m-004')).toBeNull();
    expect(h.gmail.calls.full).not.toContain('m-004');

    const report = await h.service.poll({ now: NOW });
    expect(report.stored).toEqual(['m-004']);
    expect(h.gmail.calls.full).toContain('m-004');
    expect(h.model.calls).toBe(4);
    expect(await h.service.listCandidates()).toEqual([]);
  });

  it('dismiss keeps the thread out for good: never listed again, later mail never read', async () => {
    const h = buildInboxHarness();
    h.gmail.receive(
      message({
        id: 'm-200',
        threadId: 'th-200',
        labels: ['INBOX', 'Label_2'],
        subject: 'Conference invitation',
        body: 'CANDIDATE-BODY-MARKER-200',
      }),
    );
    await h.service.poll({ now: NOW });
    expect((await h.service.listCandidates()).map((c) => c.threadId)).toContain('th-200');

    await h.service.dismiss('th-200', 'a conference mailing, not MUG');
    expect((await h.repos.candidates.findByThreadId('th-200'))?.state).toBe('dismissed');
    expect((await h.service.listCandidates()).map((c) => c.threadId)).not.toContain('th-200');

    // More mail arrives under the loose label: not fetched, not listed, never read.
    const metadataBefore = h.gmail.calls.metadata.length;
    h.gmail.receive(
      message({
        id: 'm-201',
        threadId: 'th-200',
        labels: ['INBOX', 'Label_2'],
        body: 'CANDIDATE-BODY-MARKER-201',
      }),
    );
    await h.service.poll({ now: NOW });
    expect(h.gmail.calls.metadata.slice(metadataBefore)).not.toContain('m-201');
    expect(h.gmail.calls.full).not.toContain('m-200');
    expect(h.gmail.calls.full).not.toContain('m-201');
    expect((await h.service.listCandidates()).map((c) => c.threadId)).not.toContain('th-200');
    expect(h.model.prompts.join('\n')).not.toContain('CANDIDATE-BODY-MARKER');
    // Neither decision is on a message record: there is none for this thread.
    expect(await h.repos.inbound.findByThreadId('th-200')).toEqual([]);
  });

  it('a thread labelled BOTH is admitted: the stronger label wins', async () => {
    const h = buildInboxHarness();
    h.gmail.receive(
      message({ id: 'm-300', threadId: 'th-300', labels: ['INBOX', 'Label_1', 'Label_2'] }),
    );
    const report = await h.service.poll({ now: NOW });
    expect(report.stored).toContain('m-300');
    expect((await h.service.listCandidates()).map((c) => c.threadId)).not.toContain('th-300');
  });

  it('a candidate that later gets the strong label is admitted and its candidate record follows', async () => {
    const h = buildInboxHarness();
    await h.service.poll({ now: NOW });
    h.gmail.applyLabel('m-004', 'mug-agents');
    const report = await h.service.poll({ now: NOW });
    expect(report.stored).toEqual(['m-004']);
    expect((await h.repos.candidates.findByThreadId('th-004'))?.state).toBe('admitted');
  });
});

describe('1.4 a configured label that does not exist in Gmail is an error, never "everything"', () => {
  it('fails before any listing', async () => {
    const gmail = FakeGmail.fromFixture();
    gmail.labels.splice(0, gmail.labels.length, { id: 'Label_2', name: 'mug-maybe' });
    const h = buildInboxHarness({ gmail });
    await expect(h.service.poll({ now: NOW })).rejects.toThrow(/mug-agents/);
    expect(gmail.calls.list).toEqual([]);
    expect(gmail.calls.metadata).toEqual([]);
    expect(gmail.calls.full).toEqual([]);
    expect(h.model.calls).toBe(0);
  });
});

describe('poll --dry-run', () => {
  it('prints what it would store; stores nothing, fetches no body, calls no model, moves no cursor', async () => {
    const h = buildInboxHarness();
    const report = await h.service.poll({ now: NOW, dryRun: true });
    expect(report.wouldStore.map((w) => w.gmailId).sort()).toEqual(IN_SCOPE_FIRST_POLL);
    expect(report.stored).toEqual([]);
    expect(h.gmail.calls.full).toEqual([]);
    expect(h.model.calls).toBe(0);
    expect(await h.repos.inbound.count()).toBe(0);
    expect((await h.repos.admitted.findMany({})).items).toEqual([]);
    expect((await h.repos.candidates.findMany({})).items).toEqual([]);
    expect(await h.repos.cursor.get()).toBeNull();
    await expectNothingPrivateLeft(h);
  });
});
