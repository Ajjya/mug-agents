import { describe, expect, it } from 'vitest';
import { GoogleGmailClient } from '../../src/inbox/gmail.client.js';
import { FakeGmailApi } from '../support/fake-gmail-api.js';
import { buildInboxHarness } from '../support/inbox-harness.js';

/**
 * The scope guarantee at the REAL client layer: the real GoogleGmailClient and the real service over a stub
 * of the Gmail API itself, counting requests by the format they asked for. The transport-level counters
 * elsewhere count calls on our own interface; this counts what would have gone over the wire.
 */
const NOW = new Date('2026-11-01T12:00:00.000Z');
const IN_SCOPE = ['m-001', 'm-005', 'm-006'];
const PRIVATE = ['m-002', 'm-003', 'm-008', 'm-007'];

describe('a whole poll through GoogleGmailClient', () => {
  async function run() {
    const api = new FakeGmailApi();
    const h = buildInboxHarness({ client: new GoogleGmailClient(api.asGmail()) });
    const report = await h.service.poll({ now: NOW });
    return { api, h, report };
  }

  it('requests a full body for exactly the in-scope messages, and never for a private or candidate one', async () => {
    const { api, h, report } = await run();
    const full = api.calls.get.filter((g) => g.format === 'full').map((g) => g.id);
    expect([...full].sort()).toEqual(IN_SCOPE);
    for (const id of [...PRIVATE, 'm-004']) expect(full).not.toContain(id);
    expect([...report.stored].sort()).toEqual(IN_SCOPE);
    expect(h.model.calls).toBe(3);
  });

  it('every message listing carried a label id; nothing asked for raw, and no unscoped list exists', async () => {
    const { api } = await run();
    expect(api.calls.list.length).toBeGreaterThan(0);
    expect(
      api.calls.list.every(
        (l) => l.labelIds.length === 1 && /^Label_[12]$/.test(l.labelIds[0] ?? ''),
      ),
    ).toBe(true);
    expect(api.calls.get.every((g) => ['metadata', 'full'].includes(g.format))).toBe(true);
    expect(api.calls.threads.every((t) => t.format === 'minimal')).toBe(true);
  });

  it('metadata requests name their headers; private mail is never even asked for', async () => {
    const { api } = await run();
    const meta = api.calls.get.filter((g) => g.format === 'metadata');
    expect(meta.length).toBeGreaterThan(0);
    expect(meta.every((g) => (g.metadataHeaders?.length ?? 0) >= 5)).toBe(true);
    for (const id of PRIVATE) expect(api.calls.get.map((g) => g.id)).not.toContain(id);
  });

  it('the snippet the API volunteers on a metadata fetch is stored nowhere', async () => {
    const { h } = await run();
    const everything = JSON.stringify({
      candidates: (await h.repos.candidates.findMany({ limit: 50 })).items,
      inbound: await h.repos.inbound.findRecent(50),
    });
    expect(everything).not.toContain('SNIPPET-OF-');
  });

  it('a second poll over the same mailbox requests no body at all', async () => {
    const { api, h } = await run();
    const before = api.calls.get.filter((g) => g.format === 'full').length;
    await h.service.poll({ now: NOW });
    expect(api.calls.get.filter((g) => g.format === 'full').length).toBe(before);
  });
});
