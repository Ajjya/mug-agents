import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

describe('config policy', () => {
  it('process.env is read only in the config module', () => {
    const offenders = [...sourceFiles('src')].filter(
      (f) => !f.endsWith('config.module.ts') && /process\.env/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
