import { describe, expect, it } from 'vitest';
import { formatPollReport } from '../../src/inbox/format.js';
import { buildInboxHarness } from '../support/inbox-harness.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const PRIVATE_TEXT =
  /PRIVATE-MARKER|bank\.invalid|employer\.invalid|clinic\.invalid|CANDIDATE-BODY-MARKER|statement|application|appointment/i;

describe('what `inbox poll --dry-run` prints (the first real run)', () => {
  it('lists the in-scope messages by date, thread and subject, says nothing was done, and prints nothing about private mail', async () => {
    const h = buildInboxHarness();
    const r = await h.service.poll({ now: NOW, dryRun: true });
    const text = formatPollReport(r, { dryRun: true, label: 'mug-agents' }).join('\n');

    expect(text).toMatch(/^DRY RUN: nothing stored, no body fetched, no model called\./);
    expect(text).toContain('WOULD STORE AND TRIAGE (3), label "mug-agents":');
    expect(text).toContain('2026-10-20  thread th-001  Re: Speaking at the Winter Meetup');
    expect(text).toContain('2026-10-24  thread th-005  Kettle Room booking');
    expect(text).toContain('2026-10-27  thread th-001  Re: Speaking at the Winter Meetup');
    // Not one private subject, sender or body word; not even the candidate's subject.
    expect(text).not.toMatch(PRIVATE_TEXT);
    expect(text).not.toMatch(/Database Weekly/);
    // No address of anyone, ever, in this output.
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    // Counts for what was set aside, and the real stored/triaged line is NOT shown.
    expect(text).toMatch(/Dropped \(not in scope, nothing stored or fetched\): 0;/);
    expect(text).not.toMatch(/^Stored /m);
  });

  it('even under a WRONG query, the dropped private mail is only a count', async () => {
    const h = buildInboxHarness();
    h.gmail.ignoreLabelScope = true;
    const r = await h.service.poll({ now: NOW, dryRun: true });
    const text = formatPollReport(r, { dryRun: true, label: 'mug-agents' }).join('\n');
    expect(r.dropped).toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/Dropped \(not in scope, nothing stored or fetched\): [4-9]/);
    expect(text).not.toMatch(PRIVATE_TEXT);
  });

  it('a real poll prints counts only: no subject, no address', async () => {
    const h = buildInboxHarness();
    const r = await h.service.poll({ now: NOW });
    const text = formatPollReport(r, { dryRun: false, label: 'mug-agents' }).join('\n');
    expect(text).toContain(
      'Stored 3; already stored 0; triaged 3; triage failed 0; triage pending 0.',
    );
    expect(text).not.toMatch(/Winter Meetup|Kettle|Database Weekly/);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(text).toContain('new candidate threads: 1');
  });

  it('says so when the history id expired, when there is no cursor yet, and when the sweep was cut short', async () => {
    const h = buildInboxHarness();
    const first = await h.service.poll({ now: NOW });
    expect(formatPollReport(first, { dryRun: false, label: 'x' }).join('\n')).toContain(
      'History: no cursor yet.',
    );
    h.gmail.expireHistory();
    const second = await h.service.poll({ now: NOW });
    expect(formatPollReport(second, { dryRun: false, label: 'x' }).join('\n')).toContain(
      'EXPIRED, fell back to the bounded label sweep',
    );
    const h2 = buildInboxHarness({ config: { sweepMaxPages: 1 } });
    h2.gmail.pageSize = 1;
    const cut = await h2.service.poll({ now: NOW });
    expect(formatPollReport(cut, { dryRun: false, label: 'x' }).join('\n')).toContain(
      'hit its page limit (GMAIL_SWEEP_MAX_PAGES)',
    );
  });

  it('mentions mail left alone because its thread was excluded after it was stored', async () => {
    const h = buildInboxHarness();
    const { ProviderError } = await import('../../src/llm/model.types.js');
    h.model.fail = new ProviderError('unavailable', 'HTTP 503', 503);
    await h.service.poll({ now: NOW });
    await h.service.excludeThread('th-001', 'no');
    h.model.fail = undefined;
    const r = await h.service.poll({ now: NOW });
    expect(formatPollReport(r, { dryRun: false, label: 'x' }).join('\n')).toContain(
      'left alone (excluded threads) 2',
    );
  });
});
