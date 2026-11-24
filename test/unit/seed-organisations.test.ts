import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedOrganisations } from '../../src/retrieval/seed-organisations.js';
import { InMemoryOrganisationsRepository } from '../support/in-memory.repositories.js';
import { SAMPLE } from '../support/store-suite.js';

const write = (orgs: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-orgs-'));
  writeFileSync(join(dir, 'organisations.seed.json'), JSON.stringify({ organisations: orgs }));
  return dir;
};

describe('seedOrganisations', () => {
  it('loads the sample seed, then is idempotent', async () => {
    const repo = new InMemoryOrganisationsRepository();
    const first = await seedOrganisations(SAMPLE, repo);
    expect(first.created.length).toBeGreaterThan(0);
    const second = await seedOrganisations(SAMPLE, repo);
    expect(second.created).toEqual([]);
    expect(second.unchanged).toEqual(first.created);
  });

  it('updates a changed field and keeps contacts already on the organisation', async () => {
    const repo = new InMemoryOrganisationsRepository();
    await seedOrganisations(write([{ name: 'Hall', kind: 'venue', capacity: 50 }]), repo);
    const org = await repo.findByNameAndKind('Hall', 'venue');
    if (!org) throw new Error('not seeded');
    await repo.updateWithRetry(org._id, () => ({ contacts: [{ name: 'Someone' }] }));
    const r = await seedOrganisations(write([{ name: 'Hall', kind: 'venue', capacity: 60 }]), repo);
    expect(r.updated).toEqual(['Hall']);
    const after = await repo.findByNameAndKind('Hall', 'venue');
    expect(after?.capacity).toBe(60);
    expect(after?.contacts).toHaveLength(1);
  });

  it('rejects contacts in the seed file and duplicates', async () => {
    const repo = new InMemoryOrganisationsRepository();
    await expect(
      seedOrganisations(
        write([{ name: 'A', kind: 'venue', contacts: [{ name: 'x', email: 'x@y.z' }] }]),
        repo,
      ),
    ).rejects.toThrow();
    await expect(
      seedOrganisations(
        write([
          { name: 'A', kind: 'venue' },
          { name: 'A', kind: 'venue' },
        ]),
        repo,
      ),
    ).rejects.toThrow();
  });
});
