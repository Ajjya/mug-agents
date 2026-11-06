import { describe, expect, it } from 'vitest';
import { ConfigError, parseEnv } from '../../src/config/env.schema.js';

describe('parseEnv', () => {
  const valid = { MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB: 'x' };

  it('applies defaults and coerces PORT', () => {
    expect(parseEnv({ ...valid, PORT: '4000' })).toEqual({
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
});
