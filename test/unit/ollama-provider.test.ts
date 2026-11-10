import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/llm/model.types.js';
import { OllamaProvider } from '../../src/llm/ollama.provider.js';
import { Semaphore } from '../../src/llm/semaphore.js';

const SECRET = 'sk-test-SECRET-123';
const req = { model: 'gpt-oss:20b', prompt: 'hi', temperature: 0 as const, timeoutMs: 500 };

function provider(fetchImpl: typeof fetch, apiKey: string | undefined = SECRET, limit = 3) {
  return new OllamaProvider({
    baseUrl: 'https://ollama.test/v1/',
    apiKey,
    semaphore: new Semaphore(limit),
    fetchImpl,
  });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('OllamaProvider', () => {
  it('calls /chat/completions with bearer auth, temperature 0 and no schema, and maps usage', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(
      json(200, {
        choices: [{ message: { content: '{"a":1}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }),
    );
    const r = await provider(f).chat(req);
    expect(r).toMatchObject({ content: '{"a":1}', promptTokens: 11, completionTokens: 4 });
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('https://ollama.test/v1/chat/completions');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-oss:20b', temperature: 0 });
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('format');
  });

  it('declares that it does not constrain output (probe result)', () => {
    expect(provider(vi.fn<typeof fetch>()).constrainsOutput).toBe(false);
  });

  it.each([
    [401, 'unavailable'],
    [403, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [429, 'queue_full'],
    [408, 'timeout'],
    [404, 'rejected'],
    [400, 'rejected'],
  ])('maps HTTP %i to kind %s, without leaking the key or the body', async (status, kind) => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json(status, { error: `echo ${SECRET}` }));
    const err = await provider(f)
      .chat(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe(kind);
    expect((err as ProviderError).status).toBe(status);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(SECRET);
  });

  it('maps a network failure to transport and a timeout to timeout, never leaking the key', async () => {
    const net = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${SECRET}`));
    const e1 = (await provider(net)
      .chat(req)
      .catch((e: unknown) => e)) as ProviderError;
    expect(e1.kind).toBe('transport');
    expect(JSON.stringify(e1, Object.getOwnPropertyNames(e1))).not.toContain(SECRET);

    const slow = vi
      .fn<typeof fetch>()
      .mockRejectedValue(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    expect(
      (
        (await provider(slow)
          .chat(req)
          .catch((e: unknown) => e)) as ProviderError
      ).kind,
    ).toBe('timeout');
  });

  it('a missing key fails at call time with a clear, key-free error and never hits the network', async () => {
    const f = vi.fn<typeof fetch>();
    const noKey = new OllamaProvider({
      baseUrl: 'https://ollama.test/v1',
      apiKey: undefined,
      semaphore: new Semaphore(1),
      fetchImpl: f,
    });
    const err = (await noKey.chat(req).catch((e: unknown) => e)) as ProviderError;
    expect(err.kind).toBe('unavailable');
    expect(err.message).toContain('OLLAMA_API_KEY');
    expect(f).not.toHaveBeenCalled();
  });

  it('shares one semaphore: never more than OLLAMA_MAX_CONCURRENCY requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const f = vi.fn<typeof fetch>().mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 3));
      inFlight--;
      return json(200, { choices: [{ message: { content: '{}' } }] });
    });
    const p = provider(f, SECRET, 3);
    await Promise.all(Array.from({ length: 12 }, () => p.chat(req)));
    expect(peak).toBe(3);
    expect(f).toHaveBeenCalledTimes(12);
  });
});
