import { describe, expect, it, vi } from 'vitest';
import type { MongoClient } from 'mongodb';
import { ResetRefusedError, assertResetAllowed, resetDevDb } from '../../scripts/reset-dev-db.js';

describe('assertResetAllowed', () => {
  it('allows a development database ending in _dev', () => {
    expect(() => {
      assertResetAllowed({ NODE_ENV: 'development', MONGODB_DB: 'mug_agents_dev' });
    }).not.toThrow();
    expect(() => {
      assertResetAllowed({ NODE_ENV: 'test', MONGODB_DB: 'x_dev' });
    }).not.toThrow();
  });

  it("refuses when NODE_ENV is 'production', even for a _dev name", () => {
    expect(() => {
      assertResetAllowed({ NODE_ENV: 'production', MONGODB_DB: 'mug_agents_dev' });
    }).toThrow(/production/);
  });

  it.each(['mug_agents', 'mug_agents_prod', 'mug_dev_old', 'dev', 'mug_agents_DEV', '_dev'])(
    'refuses MONGODB_DB "%s"',
    (name) => {
      const attempt = () => {
        assertResetAllowed({ NODE_ENV: 'development', MONGODB_DB: name });
      };
      expect(attempt).toThrow(ResetRefusedError);
      expect(attempt).toThrow(/does not end in "_dev"/);
    },
  );
});

describe('resetDevDb guards', () => {
  it('refuses before touching the server', async () => {
    const db = vi.fn();
    const client = { db } as unknown as MongoClient;
    await expect(
      resetDevDb(client, { NODE_ENV: 'development', MONGODB_DB: 'mug_agents' }),
    ).rejects.toBeInstanceOf(ResetRefusedError);
    await expect(
      resetDevDb(client, { NODE_ENV: 'production', MONGODB_DB: 'x_dev' }),
    ).rejects.toBeInstanceOf(ResetRefusedError);
    expect(db).not.toHaveBeenCalled();
  });
});
