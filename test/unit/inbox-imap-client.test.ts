import { describe, expect, it } from 'vitest';
import type { MessageRef } from '../../src/inbox/gmail.transport.js';
import { GmailTransportError } from '../../src/inbox/gmail.errors.js';
import { ImapGmailClient } from '../../src/inbox/imap.client.js';
import { FakeGmail } from '../support/fake-gmail.js';
import { FakeImapSession } from '../support/fake-imap.js';
import { NEUTRAL_ANSWER, buildInboxHarness } from '../support/inbox-harness.js';

/**
 * ACCESS-CONTROL tests at the protocol layer (spec 1). They count what crossed the IMAP boundary: which
 * folders were opened and how, which fetch items were asked for, which body parts were downloaded. They
 * do not assert on what was stored.
 */

const LABELS = ['mug-agents', 'mug-maybe'];
const NOW = new Date('2026-11-01T12:00:00.000Z');

function setup() {
  const gmail = FakeGmail.fromFixture();
  const session = new FakeImapSession(gmail);
  const client = new ImapGmailClient(() => session, LABELS);
  return { gmail, session, client };
}

describe('folders: LIST decides, and only the two label folders are ever opened', () => {
  it('resolves a configured label through LIST to its folder path (case-insensitively)', async () => {
    const { client } = setup();
    expect(await client.resolveLabelId('mug-agents')).toBe('mug-agents');
    expect(await client.resolveLabelId('MUG-Maybe')).toBe('mug-maybe');
  });

  it('a configured label that LIST does not show is null, not "everything"', async () => {
    const gmail = FakeGmail.empty();
    gmail.labels.splice(0, gmail.labels.length, { id: 'Label_2', name: 'mug-maybe' });
    const client = new ImapGmailClient(() => new FakeImapSession(gmail), LABELS);
    expect(await client.resolveLabelId('mug-agents')).toBeNull();
  });

  it('refuses a name that is not one of the configured labels, and never LISTs for it', async () => {
    const { client, session } = setup();
    await expect(client.resolveLabelId('INBOX')).rejects.toBeInstanceOf(GmailTransportError);
    await expect(client.resolveLabelId('[Gmail]/All Mail')).rejects.toBeInstanceOf(
      GmailTransportError,
    );
    expect(session.connects).toBe(0);
    expect(session.opened).toEqual([]);
  });

  it('refuses to open INBOX or All Mail even when asked directly, even when configured as a label', async () => {
    const { session } = setup();
    for (const path of ['INBOX', '[Gmail]/All Mail']) {
      const client = new ImapGmailClient(() => session, [path]); // a config that slipped past boot validation
      await expect(client.resolveLabelId(path)).rejects.toBeInstanceOf(GmailTransportError);
      await expect(client.listMessageRefs({ labelId: path, limit: 10 })).rejects.toBeInstanceOf(
        GmailTransportError,
      );
    }
    expect(session.opened).toEqual([]); // not a single lock was taken
  });

  it('refuses a folder that was never resolved, even if it exists', async () => {
    const { client, session } = setup();
    await expect(client.listMessageRefs({ labelId: 'mug-agents', limit: 10 })).rejects.toThrow(
      /not one of the configured label folders/,
    );
    expect(session.opened).toEqual([]);
  });

  it('every folder is opened READ-ONLY (EXAMINE), through the one lock call', async () => {
    const { client, session } = setup();
    await client.resolveLabelId('mug-agents');
    await client.listMessageRefs({ labelId: 'mug-agents', limit: 10 });
    expect(session.opened).toEqual([{ path: 'mug-agents', readOnly: true }]);
  });
});

describe('listing: UIDs above the cursor, ascending, in pages', () => {
  it('lists UIDs above afterUid only, and filters out the highest UID that `n:*` always returns', async () => {
    const { client, gmail } = setup();
    await client.resolveLabelId('mug-agents');
    const top = gmail.highestUid('mug-agents');
    const page = await client.listMessageRefs({ labelId: 'mug-agents', afterUid: top, limit: 10 });
    expect(page.refs).toEqual([]);
    expect(page.hasMore).toBe(false);
    const all = await client.listMessageRefs({ labelId: 'mug-agents', limit: 10 });
    expect(all.refs.map((r) => r.id)).toEqual(['m-001', 'm-005', 'm-006']);
    expect(all.refs.map((r) => r.uid)).toEqual([1, 2, 3]);
    expect(all.refs.every((r) => r.folder === 'mug-agents')).toBe(true);
    expect(all.uidValidity).toBe('v1');
  });

  it('pages: a limit smaller than the folder reports hasMore', async () => {
    const { client } = setup();
    await client.resolveLabelId('mug-agents');
    const first = await client.listMessageRefs({ labelId: 'mug-agents', limit: 2 });
    expect(first.refs).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const next = await client.listMessageRefs({
      labelId: 'mug-agents',
      afterUid: first.refs[1]?.uid ?? 0,
      limit: 2,
    });
    expect(next.refs.map((r) => r.id)).toEqual(['m-006']);
    expect(next.hasMore).toBe(false);
  });
});

describe('a candidate fetch is the ENVELOPE and nothing else', () => {
  it('asks for envelope, ids, labels and date only: no body structure, no part, no source', async () => {
    const { client, session } = setup();
    await client.resolveLabelId('mug-maybe');
    const [ref] = (await client.listMessageRefs({ labelId: 'mug-maybe', limit: 10 })).refs;
    expect(ref?.id).toBe('m-004');
    session.fetches.length = 0;
    const meta = await client.getMetadata(ref ?? { id: '', threadId: '', folder: '', uid: 0 });
    expect(session.fetches).toHaveLength(1);
    expect([...(session.fetches[0]?.items ?? [])].sort()).toEqual(
      ['emailId', 'envelope', 'internalDate', 'labels', 'threadId', 'uid'].sort(),
    );
    expect(session.downloads).toEqual([]);
    expect(JSON.stringify(meta)).not.toContain('CANDIDATE-BODY-MARKER');
    expect(meta.headers.subject).toBe('Database Weekly: issue 412');
  });

  it("the folder's own label is added to labelIds (X-GM-LABELS leaves it out), and \\Sent is SENT", async () => {
    const { client, gmail } = setup();
    gmail.receive({
      id: 'm-950',
      threadId: 'th-950',
      labels: ['SENT', 'Label_1'],
      receivedAt: '2026-10-30T09:00:00.000Z',
      from: 'a@b.invalid',
      to: 'c@d.invalid',
      subject: 's',
      messageId: '<950@x.invalid>',
      body: 'b',
      attachments: [],
    });
    await client.resolveLabelId('mug-agents');
    const refs = (await client.listMessageRefs({ labelId: 'mug-agents', limit: 10 })).refs;
    const ref = refs.find((r) => r.id === 'm-950');
    const meta = await client.getMetadata(ref ?? (refs[0] as MessageRef));
    expect(meta.labelIds).toContain('mug-agents');
    expect(meta.labelIds).toContain('SENT');
  });

  it('refuses a UID that no longer holds the listed message (the folder was recreated in between)', async () => {
    const { client, gmail } = setup();
    await client.resolveLabelId('mug-agents');
    const [ref] = (await client.listMessageRefs({ labelId: 'mug-agents', limit: 10 })).refs;
    gmail.recreateFolder('mug-agents'); // same UID numbers can now mean different messages
    await expect(
      client.getMetadata(ref ?? { id: '', threadId: '', folder: '', uid: 0 }),
    ).rejects.toThrow(/no longer holds|gone/);
  });
});

describe('an admitted message: text parts are downloaded, attachments are listed and never opened', () => {
  it('downloads part 1 only, lists the attachment from BODYSTRUCTURE, and reads References', async () => {
    const { client, session, gmail } = setup();
    gmail.receive({
      id: 'm-960',
      threadId: 'th-960',
      labels: ['INBOX', 'Label_1'],
      receivedAt: '2026-10-30T09:00:00.000Z',
      from: 'Someone <someone@people.invalid>',
      to: 'organiser@mug.invalid',
      subject: 'With an attachment',
      messageId: '<960@people.invalid>',
      references: '<a@x.invalid> <b@x.invalid>',
      body: 'The body text.',
      attachments: [{ filename: 'slides.pdf', mimeType: 'application/pdf', sizeBytes: 123456 }],
    });
    await client.resolveLabelId('mug-agents');
    const refs = (await client.listMessageRefs({ labelId: 'mug-agents', limit: 10 })).refs;
    const ref = refs.find((r) => r.id === 'm-960');
    const full = await client.getFull(ref ?? (refs[0] as MessageRef));
    expect(full.bodyText).toBe('The body text.');
    expect(full.attachments).toEqual([
      { filename: 'slides.pdf', mimeType: 'application/pdf', sizeBytes: 123456 },
    ]);
    expect(full.headers.references).toBe('<a@x.invalid> <b@x.invalid>');
    expect(session.downloads.map((d) => d.part)).toEqual(['1']); // the PDF (part 2) was never downloaded
  });
});

describe('end to end over the REAL client: what crosses the IMAP boundary (spec 1.1, 1.2)', () => {
  function run() {
    const gmail = FakeGmail.fromFixture();
    const session = new FakeImapSession(gmail);
    const client = new ImapGmailClient(() => session, LABELS);
    const h = buildInboxHarness({ gmail, client });
    return { gmail, session, h };
  }

  it('only the two label folders are opened, always with EXAMINE; INBOX and All Mail never', async () => {
    const { session, h } = run();
    await h.service.poll({ now: NOW });
    await h.service.poll({ now: NOW });
    const paths = new Set(session.opened.map((o) => o.path));
    expect(paths).toEqual(new Set(['mug-agents', 'mug-maybe']));
    expect(session.opened.every((o) => o.readOnly)).toBe(true);
  });

  it('a candidate thread: no body part downloaded, no body-structure fetched, no model call carries its text', async () => {
    const { session, h } = run();
    await h.service.poll({ now: NOW });
    const candidateFetches = session.fetches.filter((f) => f.path === 'mug-maybe');
    expect(candidateFetches.length).toBeGreaterThan(0);
    for (const f of candidateFetches) {
      expect(f.items).not.toContain('bodyStructure');
      expect(f.items).not.toContain('source');
      expect(f.items).not.toContain('bodyParts');
    }
    expect(session.downloads.filter((d) => d.path === 'mug-maybe')).toEqual([]);
    expect(h.model.prompts.join('\n')).not.toContain('CANDIDATE-BODY-MARKER'); // COUNTED at the model
    expect(h.model.calls).toBe(3); // the three labelled messages, nothing else
    expect(NEUTRAL_ANSWER.length).toBeGreaterThan(0);
  });

  it('private mail in INBOX is neither listed, fetched nor downloaded', async () => {
    const { session, h } = run();
    await h.service.poll({ now: NOW });
    // PRIVATE messages are in INBOX only; every fetch and download was inside a label folder.
    expect(session.fetches.every((f) => f.path === 'mug-agents' || f.path === 'mug-maybe')).toBe(
      true,
    );
    expect(session.downloads.every((d) => d.path === 'mug-agents')).toBe(true);
    expect(session.searches.every((s) => s.path === 'mug-agents' || s.path === 'mug-maybe')).toBe(
      true,
    );
  });

  it('the session is closed by close(), and a never-used client has nothing to close', async () => {
    const { session, h } = run();
    await h.service.poll({ now: NOW });
    const client = new ImapGmailClient(() => session, LABELS);
    await client.close(); // nothing connected: no logout
    expect(session.logouts).toBe(0);
  });
});
