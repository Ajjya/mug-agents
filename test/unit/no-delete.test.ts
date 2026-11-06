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

describe('autonomy policy: agents never delete', () => {
  it('src contains no delete helpers or driver delete calls', () => {
    const banned =
      /\b(deleteOne|deleteMany|findOneAndDelete|bulkWrite|drop(Collection|Database)?)\s*\(|\bdelete\w*\s*\(/;
    const offenders = [...sourceFiles('src')].filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
