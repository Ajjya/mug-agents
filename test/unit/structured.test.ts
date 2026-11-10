import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ModelRef } from '../../src/config/env.schema.js';
import { ProviderUnavailableError, StructuredOutputError } from '../../src/llm/errors.js';
import { ProviderError } from '../../src/llm/model.types.js';
import { callStructured, type StructuredDeps } from '../../src/llm/structured.js';
import { StubProvider, silentLogger, type Scripted } from '../support/stub-provider.js';

const Schema = z
  .object({ owner: z.enum(['organiser', 'venue-lead']), title: z.string().min(1) })
  .strict();
const VALID = JSON.stringify({ owner: 'organiser', title: 'Book the venue' });
const BAD_ENUM = JSON.stringify({ owner: 'alice', title: 'x' });

const ladder: ModelRef[] = [
  { provider: 'ollama', model: 'small' },
  { provider: 'ollama', model: 'medium' },
  { provider: 'ollama', model: 'large' },
];

function setup(script: Scripted[], over: Partial<StructuredDeps> = {}) {
  const provider = new StubProvider(script);
  const sleeps: number[] = [];
  const deps: StructuredDeps = {
    ladder,
    provider: () => provider,
    maxAttempts: 6,
    timeoutMs: 1000,
    logger: silentLogger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...over,
  };
  const run = () => callStructured(Schema, 'PROMPT', { node: 'testNode' }, deps);
  return { provider, sleeps, run };
}

beforeEach(() => {
  silentLogger.logs.length = 0;
});

describe('callStructured', () => {
  it('returns a valid first answer with one record and temperature 0', async () => {
    const { provider, run } = setup([VALID]);
    const r = await run();
    expect(r.value).toEqual({ owner: 'organiser', title: 'Book the venue' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({
      node: 'testNode',
      model: 'ollama:small',
      attempt: 1,
      rung: 0,
      tokensIn: 10,
      tokensOut: 5,
      latencyMs: 7,
      outcome: 'valid',
      constrained: false,
    });
    expect(provider.requests[0]?.temperature).toBe(0);
    expect(provider.requests[0]?.model).toBe('small');
  });

  it('puts the schema in the prompt when the provider does not constrain output', async () => {
    const { provider, run } = setup([VALID]);
    await run();
    const prompt = provider.requests[0]?.prompt ?? '';
    expect(prompt).toContain('PROMPT');
    expect(prompt).toContain('"organiser"');
    expect(prompt).toContain('JSON Schema');
    expect(provider.requests[0]?.jsonSchema).toBeUndefined();
  });

  it('passes the schema as jsonSchema (not in the prompt) when the provider constrains output', async () => {
    const provider = new StubProvider([VALID], true);
    await callStructured(
      Schema,
      'PROMPT',
      { node: 'n' },
      {
        ladder,
        provider: () => provider,
        maxAttempts: 4,
        timeoutMs: 1,
        logger: silentLogger,
      },
    );
    expect(provider.requests[0]?.jsonSchema).toBeDefined();
    expect(provider.requests[0]?.prompt).not.toContain('JSON Schema');
  });

  it('invalid-then-valid: retries the SAME rung once, with the issues in the prompt', async () => {
    const { provider, run } = setup([BAD_ENUM, VALID]);
    const r = await run();
    expect(r.calls.map((c) => [c.rung, c.outcome])).toEqual([
      [0, 'invalid'],
      [0, 'valid'],
    ]);
    expect(provider.requests.map((q) => q.model)).toEqual(['small', 'small']);
    expect(provider.requests[1]?.prompt).toContain('owner');
    expect(provider.requests[1]?.prompt).toContain('rejected by validation');
    expect(provider.requests[0]?.prompt).not.toContain('rejected by validation');
  });

  it('treats non-JSON and code-fenced output as invalid (no silent repair)', async () => {
    const { run } = setup(['```json\n' + VALID + '\n```', VALID]);
    const r = await run();
    expect(r.calls.map((c) => c.outcome)).toEqual(['invalid', 'valid']);
  });

  it('rejects unknown keys such as an invented id', async () => {
    const withId = JSON.stringify({
      owner: 'organiser',
      title: 'x',
      _id: '507f1f77bcf86cd799439011',
    });
    const { run } = setup([withId, VALID]);
    const r = await run();
    expect(r.calls[0]?.outcome).toBe('invalid');
    expect(r.calls[0]?.issues?.join(' ')).toContain('_id');
  });

  it('always-invalid: one same-rung retry, then the next rung, then StructuredOutputError', async () => {
    const { provider, run } = setup([BAD_ENUM, BAD_ENUM, BAD_ENUM, BAD_ENUM, BAD_ENUM, BAD_ENUM]);
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    const e = err as StructuredOutputError;
    expect(e.reason).toBe('ladder_exhausted');
    expect(e.node).toBe('testNode');
    expect(e.attempts).toHaveLength(6);
    expect(provider.requests.map((q) => q.model)).toEqual([
      'small',
      'small',
      'medium',
      'medium',
      'large',
      'large',
    ]);
    expect(e.issues.length).toBeGreaterThan(0);
    // issues, never raw output
    expect(e.message).not.toContain('alice');
    expect(silentLogger.logs.filter((l) => l.message === 'llm rung change')).toHaveLength(2);
  });

  it('stops at LLM_MAX_ATTEMPTS even if rungs remain', async () => {
    const { provider, run } = setup([BAD_ENUM, BAD_ENUM, BAD_ENUM, BAD_ENUM], { maxAttempts: 4 });
    const e = (await run().catch((x: unknown) => x)) as StructuredOutputError;
    expect(e).toBeInstanceOf(StructuredOutputError);
    expect(e.reason).toBe('max_attempts');
    expect(provider.requests).toHaveLength(4);
    expect(provider.requests.map((q) => q.model)).toEqual(['small', 'small', 'medium', 'medium']);
  });

  it('a ladder of one never escalates', async () => {
    const { provider, run } = setup([BAD_ENUM, BAD_ENUM], { ladder: [ladder[0] as ModelRef] });
    await expect(run()).rejects.toBeInstanceOf(StructuredOutputError);
    expect(provider.requests).toHaveLength(2);
  });

  it('honours startAt and rejects an out-of-range start', async () => {
    const provider = new StubProvider([VALID]);
    const deps: StructuredDeps = {
      ladder,
      provider: () => provider,
      maxAttempts: 3,
      timeoutMs: 1,
      logger: silentLogger,
    };
    await callStructured(Schema, 'p', { node: 'n', startAt: 2 }, deps);
    expect(provider.requests[0]?.model).toBe('large');
    await expect(callStructured(Schema, 'p', { node: 'n', startAt: 3 }, deps)).rejects.toThrow(
      RangeError,
    );
  });

  it('queue_full: retried on the SAME rung after a backoff, never escalated', async () => {
    const full = new ProviderError('queue_full', 'busy', 429);
    const { provider, sleeps, run } = setup([full, full, VALID]);
    const r = await run();
    expect(provider.requests.map((q) => q.model)).toEqual(['small', 'small', 'small']);
    expect(r.calls.map((c) => c.outcome)).toEqual(['queue_full', 'queue_full', 'valid']);
    expect(sleeps).toEqual([1000, 2000]);
    expect(silentLogger.logs.some((l) => l.message === 'llm rung change')).toBe(false);
  });

  it('queue_full that never drains aborts with ProviderUnavailableError', async () => {
    const full = new ProviderError('queue_full', 'busy', 429);
    const { provider, run } = setup([full, full, full, full]);
    const e = await run().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(provider.requests).toHaveLength(3); // 1 try + 2 backoff retries
    expect(new Set(provider.requests.map((q) => q.model))).toEqual(new Set(['small']));
  });

  it.each([
    ['401', new ProviderError('unavailable', 'authentication rejected (HTTP 401)', 401)],
    ['503', new ProviderError('unavailable', 'provider error (HTTP 503)', 503)],
  ])(
    'HTTP %s aborts with ProviderUnavailableError without trying another rung',
    async (_n, failure) => {
      const { provider, run } = setup([failure, VALID]);
      const e = await run().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ProviderUnavailableError);
      expect(e).not.toBeInstanceOf(StructuredOutputError);
      expect((e as ProviderUnavailableError).status).toBe(failure.status);
      expect((e as ProviderUnavailableError).attempts).toHaveLength(1);
      expect(provider.requests).toHaveLength(1);
    },
  );

  it('timeout counts as an attempt and is retried like a validation failure', async () => {
    const t = new ProviderError('timeout', 'request timed out', undefined, 1000);
    const { provider, run } = setup([t, VALID]);
    const r = await run();
    expect(r.calls.map((c) => [c.outcome, c.latencyMs])).toEqual([
      ['timeout', 1000],
      ['valid', 7],
    ]);
    expect(provider.requests.map((q) => q.model)).toEqual(['small', 'small']);
    expect(provider.requests[1]?.prompt).not.toContain('rejected by validation');
  });

  it('two timeouts on a rung move to the next rung', async () => {
    const t = new ProviderError('timeout', 'request timed out');
    const { provider, run } = setup([t, t, VALID]);
    await run();
    expect(provider.requests.map((q) => q.model)).toEqual(['small', 'small', 'medium']);
  });

  it('a rejected model (e.g. unknown name) moves to the next rung at once', async () => {
    const { provider, run } = setup([new ProviderError('rejected', 'HTTP 404', 404), VALID]);
    await run();
    expect(provider.requests.map((q) => q.model)).toEqual(['small', 'medium']);
  });

  it('logs every call with metadata only: no prompt, no raw output', async () => {
    const { run } = setup([BAD_ENUM, VALID]);
    await run();
    const text = JSON.stringify(silentLogger.logs);
    expect(text).not.toContain('PROMPT');
    expect(text).not.toContain('alice');
    expect(silentLogger.logs.filter((l) => l.message === 'llm call')).toHaveLength(2);
    expect(silentLogger.logs[0]?.params[0]).toMatchObject({
      node: 'testNode',
      model: 'ollama:small',
      attempt: 1,
      outcome: 'invalid',
    });
  });
});
