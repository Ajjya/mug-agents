import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { OrganisationInputSchema } from '../domain/organisation.schema.js';
import type { OrganisationsRepository } from '../repositories/organisations.repository.js';
import type { SeedResult } from './seed-speakers.js';

/**
 * One organisation in a seed file. Strict, and with NO contacts: names and email addresses of people
 * never go into git (add contacts by hand in the database). `history` is not seeded either, it needs
 * event ids that only exist per database.
 */
export const SeedOrganisationSchema = z
  .object({
    name: OrganisationInputSchema.shape.name,
    kind: OrganisationInputSchema.shape.kind,
    capacity: OrganisationInputSchema.shape.capacity,
    address: OrganisationInputSchema.shape.address,
    notes: OrganisationInputSchema.shape.notes,
  })
  .strict();

export const SeedOrganisationsFileSchema = z
  .object({ organisations: z.array(SeedOrganisationSchema).min(1) })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.organisations.forEach((o, i) => {
      const key = `${o.kind}:${o.name}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['organisations', i, 'name'],
          message: `duplicate organisation ${key}`,
        });
      }
      seen.add(key);
    });
  });

/**
 * Loads `<root>/organisations.seed.json` through the organisations repository. Identity is the exact
 * (name, kind) pair. An existing organisation is updated only when a seeded field changed; contacts
 * and history already on it are never touched. Returns names, not handles.
 */
export async function seedOrganisations(
  root: string,
  organisations: OrganisationsRepository,
): Promise<SeedResult> {
  const raw: unknown = JSON.parse(await readFile(join(root, 'organisations.seed.json'), 'utf8'));
  const seed = SeedOrganisationsFileSchema.parse(raw);
  const result: SeedResult = { created: [], updated: [], unchanged: [] };
  for (const o of seed.organisations) {
    const existing = await organisations.findByNameAndKind(o.name, o.kind);
    if (!existing) {
      await organisations.insert({
        name: o.name,
        kind: o.kind,
        contacts: [],
        history: [],
        ...(o.capacity === undefined ? {} : { capacity: o.capacity }),
        ...(o.address === undefined ? {} : { address: o.address }),
        ...(o.notes === undefined ? {} : { notes: o.notes }),
      });
      result.created.push(o.name);
      continue;
    }
    const changed =
      (o.capacity !== undefined && existing.capacity !== o.capacity) ||
      (o.address !== undefined && existing.address !== o.address) ||
      (o.notes !== undefined && existing.notes !== o.notes);
    if (!changed) {
      result.unchanged.push(o.name);
      continue;
    }
    await organisations.updateWithRetry(existing._id, () => ({
      ...(o.capacity === undefined ? {} : { capacity: o.capacity }),
      ...(o.address === undefined ? {} : { address: o.address }),
      ...(o.notes === undefined ? {} : { notes: o.notes }),
    }));
    result.updated.push(o.name);
  }
  return result;
}
