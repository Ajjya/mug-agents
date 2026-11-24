import { describe, expect, it } from 'vitest';
import { formatPollReport } from '../../src/inbox/format.js';
import { Triager } from '../../src/inbox/triage.js';
import { type StructuredCall, callStructured } from '../../src/llm/structured.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../../src/llm/model.types.js';
import { FakeGmail, type FixtureMessage } from '../support/fake-gmail.js';
import { NEUTRAL_ANSWER, buildInboxHarness } from '../support/inbox-harness.js';

const silent = { log: () => undefined, warn: () => undefined };
const NOW = new Date('2026-11-01T12:00:00.000Z');

/** Takes `ms` for every call and ignores timeoutMs, like a provider that hangs. */
class SlowProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly constrainsOutput = false;
  calls = 0;
  constructor(
    private readonly ms: number,
    private readonly content: string,
  ) {}
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    await new Promise<void>((resolve) => setTimeout(resolve, this.ms));
    return { content: this.content, promptTokens: 1, completionTokens: 1, latencyMs: this.ms };
  }
}

function triager(provider: LlmProvider, deadlineMs: number | undefined, maxAttempts = 50) {
  const call: StructuredCall = (s, p, o) =>
    callStructured(s, p, o, {
      // three rungs and many attempts: without a deadline this would run for a very long time
      ladder: [
        { provider: 'ollama', model: 'a' },
        { provider: 'ollama', model: 'b' },
        { provider: 'ollama', model: 'c' },
      ],
      provider: () => provider,
      maxAttempts,
      timeoutMs: 60_000,
      logger: silent,
    });
  return new Triager({
    call,
    maxChars: 6000,
    startAt: 0,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
}

describe('the per-message deadline bounds a message across the whole ladder', () => {
  it('a provider that ALWAYS takes longer than the deadline: stopped at the deadline, not after attempts x timeout', async () => {
    const provider = new SlowProvider(2000, NEUTRAL_ANSWER); // a hung call; the deadline is 60 ms
    const started = Date.now();
    const out = await triager(provider, 60).run('body', []);
    const elapsed = Date.now() - started;

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('deadline');
    expect(out.issues.join(' ')).toMatch(/per-message deadline of 60 ms after 1 attempt/);
    expect(elapsed).toBeLessThan(1000); // not 2000 ms for one call, let alone 50 x 60 000
    expect(provider.calls).toBe(1); // no further attempt was started
    expect(out.calls.map((c) => c.outcome)).toEqual(['timeout']);
  });

  it('no attempt starts after the deadline: a model that is fast but never valid stops on time, climbing no further', async () => {
    const provider = new SlowProvider(25, 'not json'); // each attempt fails validation after 25 ms
    const started = Date.now();
    const out = await triager(provider, 80).run('body', []);
    expect(out).toMatchObject({ ok: false, reason: 'deadline' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(provider.calls).toBeLessThanOrEqual(5);
  });

  it('without a deadline a validation failure is still a validation failure (the old behaviour)', async () => {
    const provider = new SlowProvider(1, 'not json');
    const out = await triager(provider, undefined, 4).run('body', []);
    expect(out).toMatchObject({ ok: false, reason: 'validation' });
    expect(provider.calls).toBe(4);
  });

  it('a call that finishes inside the deadline is untouched', async () => {
    const out = await triager(new SlowProvider(5, NEUTRAL_ANSWER), 2000).run('body', []);
    expect(out.ok).toBe(true);
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

describe('in a poll: one slow message does not stall the batch', () => {
  it('is marked failed with the reason, the next message is triaged, and the two kinds of failure are reported apart', async () => {
    const gmail = FakeGmail.empty();
    gmail.receive(msg({ id: 'slow', threadId: 't1', body: 'SLOW-MARKER take your time' }));
    gmail.receive(msg({ id: 'fast1', threadId: 't2', from: 'A <a@people.invalid>' }));
    gmail.receive(msg({ id: 'fast2', threadId: 't3', from: 'B <b@people.invalid>' }));
    const h = buildInboxHarness({ gmail, config: { triageDeadlineMs: 60 } });
    h.model.delayMs = (prompt) => (prompt.includes('SLOW-MARKER') ? 3000 : 0);

    const started = Date.now();
    const r = await h.service.poll({ now: NOW });
    expect(Date.now() - started).toBeLessThan(2000);

    expect(r.triaged).toBe(2);
    expect(r.triageDeadlineStopped).toBe(1);
    expect(r.triageFailed).toBe(0); // not a validation failure
    const slow = await h.repos.inbound.findByGmailId('slow');
    expect(slow).toMatchObject({ triageState: 'failed' });
    expect(slow?.triageFailure?.join(' ')).toMatch(/per-message deadline of 60 ms/);
    expect((await h.repos.inbound.findByGmailId('fast1'))?.triageState).toBe('done');
    expect((await h.repos.inbound.findByGmailId('fast2'))?.triageState).toBe('done');
    // A failed triage still asks a human to look: the message is not lost.
    expect((await h.repos.tasks.findMany({ limit: 20 })).items.map((t) => t.title)).toEqual([
      expect.stringContaining('triage could not classify it'),
    ]);

    const text = formatPollReport(r, { dryRun: false, label: 'x' }).join('\n');
    expect(text).toContain(
      'triage failed 0; stopped at the per-message deadline (TRIAGE_MESSAGE_DEADLINE_MS) 1',
    );
  });
});
