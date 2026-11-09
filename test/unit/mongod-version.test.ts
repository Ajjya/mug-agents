import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MONGOD_VERSION } from '../support/mongod-version.js';

describe('pinned mongod version', () => {
  it('matches package.json config.mongodbMemoryServer.version (used by the postinstall prefetch)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      config?: { mongodbMemoryServer?: { version?: string } };
    };
    expect(pkg.config?.mongodbMemoryServer?.version).toBe(MONGOD_VERSION);
  });
});
