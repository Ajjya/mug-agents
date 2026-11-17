import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MONGOD_VERSION } from '../support/mongod-version.js';

describe('pinned mongod version', () => {
  it('matches package.json config.mongodbMemoryServer.version (used by the postinstall prefetch)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      config?: { mongodbMemoryServer?: { version?: string } };
    };
    expect(pkg.config?.mongodbMemoryServer?.version).toBe(MONGOD_VERSION);
  });

  it('the documented prepare step exists, and the README tells the truth about the network', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const prepare = pkg.scripts['test:prepare'] ?? '';
    expect(prepare).toBe('node node_modules/mongodb-memory-server/postinstall.js');
    expect(existsSync('node_modules/mongodb-memory-server/postinstall.js')).toBe(true);
    expect(pkg.scripts['verify']).toBe('npm run typecheck && npm run lint && npm test');
    const readme = readFileSync('README.md', 'utf8');
    for (const must of [
      'downloads a `mongod`',
      'MONGOMS_DOWNLOAD_DIR',
      'npm run test:prepare',
      `mongod-${MONGOD_VERSION}`,
    ]) {
      expect(readme, must).toContain(must);
    }
  });
});
