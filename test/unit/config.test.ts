import { describe, expect, it } from 'vitest';
import {
  ATTEMPTS_PER_RUNG,
  ConfigError,
  minAttemptsToReachAllRungs,
  parseEnv,
} from '../../src/config/env.schema.js';

describe('parseEnv', () => {
  const valid = { MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB: 'x' };

  it('applies defaults and coerces PORT', () => {
    expect(parseEnv({ ...valid, PORT: '4000' })).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
      ...valid,
    });
  });

  it('lists every problem and names the variables', () => {
    try {
      parseEnv({ PORT: 'abc', LOG_LEVEL: 'loud' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      for (const name of ['MONGODB_URI', 'MONGODB_DB', 'PORT', 'LOG_LEVEL'])
        expect(msg).toContain(name);
    }
  });

  it('rejects a MONGODB_URI with the wrong scheme', () => {
    expect(() => parseEnv({ ...valid, MONGODB_URI: 'http://x' })).toThrow(/MONGODB_URI/);
  });

  describe('LLM settings', () => {
    describe('attempt budget vs ladder', () => {
      const ladder3 = 'ollama:a,ollama:b,ollama:c';

      it('defaults to ATTEMPTS_PER_RUNG x ladder length', () => {
        expect(parseEnv({ ...valid, LLM_MODEL_LADDER: 'ollama:a' }).LLM_MAX_ATTEMPTS).toBe(2);
        expect(parseEnv({ ...valid, LLM_MODEL_LADDER: 'ollama:a,ollama:b' }).LLM_MAX_ATTEMPTS).toBe(
          4,
        );
        expect(parseEnv({ ...valid, LLM_MODEL_LADDER: ladder3 }).LLM_MAX_ATTEMPTS).toBe(6);
      });

      it('refuses a 3-rung ladder with LLM_MAX_ATTEMPTS=4 and names the unreachable rung', () => {
        const attempt = () =>
          parseEnv({ ...valid, LLM_MODEL_LADDER: ladder3, LLM_MAX_ATTEMPTS: '4' });
        expect(attempt).toThrow(ConfigError);
        expect(attempt).toThrow(/LLM_MAX_ATTEMPTS.*rung 3 \(ollama:c\)/);
        expect(attempt).toThrow(/need at least 5/);
      });

      it('names every unreachable rung', () => {
        expect(() =>
          parseEnv({
            ...valid,
            LLM_MODEL_LADDER: 'ollama:a,ollama:b,ollama:c,ollama:d',
            LLM_MAX_ATTEMPTS: '2',
          }),
        ).toThrow(/rung 2 \(ollama:b\), rung 3 \(ollama:c\), rung 4 \(ollama:d\)/);
      });

      it('accepts exactly the minimum that reaches the last rung', () => {
        expect(minAttemptsToReachAllRungs(3)).toBe(2 * ATTEMPTS_PER_RUNG + 1);
        expect(
          parseEnv({ ...valid, LLM_MODEL_LADDER: ladder3, LLM_MAX_ATTEMPTS: '5' }).LLM_MAX_ATTEMPTS,
        ).toBe(5);
        expect(() =>
          parseEnv({ ...valid, LLM_MODEL_LADDER: ladder3, LLM_MAX_ATTEMPTS: '4' }),
        ).toThrow();
      });

      it('a single rung is always reachable', () => {
        expect(
          parseEnv({ ...valid, LLM_MODEL_LADDER: 'ollama:a', LLM_MAX_ATTEMPTS: '1' })
            .LLM_MAX_ATTEMPTS,
        ).toBe(1);
      });

      it('the shipped default ladder and default budget are coherent', () => {
        const c = parseEnv(valid);
        expect(c.LLM_MAX_ATTEMPTS).toBeGreaterThanOrEqual(
          minAttemptsToReachAllRungs(c.LLM_MODEL_LADDER.length),
        );
      });
    });

    it('has Ollama Cloud defaults and needs no API key at boot', () => {
      const c = parseEnv(valid);
      expect(c.OLLAMA_BASE_URL).toBe('https://ollama.com/v1');
      expect(c.OLLAMA_API_KEY).toBeUndefined();
      expect(c.OLLAMA_MAX_CONCURRENCY).toBe(3);
      expect(c.LLM_TIMEOUT_MS).toBe(60_000);
      expect(c.LLM_MAX_ATTEMPTS).toBe(6); // 2 attempts x 3 rungs
      expect(c.LLM_PRICES).toEqual({});
      expect(c.LLM_MODEL_LADDER.map((r) => r.model)).toEqual([
        'gemma4:31b',
        'gpt-oss:20b',
        'mistral-large-4',
      ]);
    });

    it('parses the ladder into { provider, model }, splitting on the first colon', () => {
      const c = parseEnv({
        ...valid,
        LLM_MODEL_LADDER: 'ollama:gpt-oss:20b, ollama:mistral-large-4',
      });
      expect(c.LLM_MODEL_LADDER).toEqual([
        { provider: 'ollama', model: 'gpt-oss:20b' },
        { provider: 'ollama', model: 'mistral-large-4' },
      ]);
    });

    it('accepts a ladder of one (no escalation)', () => {
      expect(
        parseEnv({ ...valid, LLM_MODEL_LADDER: 'ollama:gpt-oss:20b' }).LLM_MODEL_LADDER,
      ).toHaveLength(1);
    });

    it('rejects an unknown provider', () => {
      expect(() => parseEnv({ ...valid, LLM_MODEL_LADDER: 'openai:gpt-5' })).toThrow(
        /LLM_MODEL_LADDER.*unknown provider "openai"/,
      );
    });

    it('rejects duplicate rungs, an empty ladder and a missing model name', () => {
      expect(() => parseEnv({ ...valid, LLM_MODEL_LADDER: 'ollama:a,ollama:b,ollama:a' })).toThrow(
        /duplicate rung/,
      );
      expect(() => parseEnv({ ...valid, LLM_MODEL_LADDER: ' , ' })).toThrow(/at least one/);
      expect(() => parseEnv({ ...valid, LLM_MODEL_LADDER: 'ollama:' })).toThrow(/missing model/);
    });

    it('parses LLM_PRICES and rejects malformed prices', () => {
      const prices = { 'ollama:gpt-oss:20b': { inputPerMTok: 0.07, outputPerMTok: 0.3 } };
      expect(parseEnv({ ...valid, LLM_PRICES: JSON.stringify(prices) }).LLM_PRICES).toEqual(prices);
      expect(() => parseEnv({ ...valid, LLM_PRICES: '{nope' })).toThrow(/LLM_PRICES.*JSON/);
      expect(() =>
        parseEnv({ ...valid, LLM_PRICES: '{"x":{"inputPerMTok":-1,"outputPerMTok":1}}' }),
      ).toThrow(/LLM_PRICES/);
    });

    it('does not echo the API key in a config error', () => {
      try {
        parseEnv({ ...valid, OLLAMA_API_KEY: 'sk-secret-value', PORT: 'abc' });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain('sk-secret-value');
      }
    });
  });
});
