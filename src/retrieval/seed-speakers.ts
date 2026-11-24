import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SPEAKER_HANDLE_RE,
  SpeakerInputSchema,
  type SpeakerInput,
} from '../domain/speaker.schema.js';
import type { SpeakersRepository } from '../repositories/speakers.repository.js';
import { CorpusError, loadCorpus } from './corpus.js';

/**
 * One speaker in a seed file. Strict, and with NO email field: email addresses never go into git.
 * Written by a human, not extracted from the corpus by a model (see specs/M3-retrieval.md 3.3).
 */
export const SeedSpeakerSchema = z
  .object({
    handle: z.string().regex(SPEAKER_HANDLE_RE),
    name: SpeakerInputSchema.shape.name,
    preferredName: SpeakerInputSchema.shape.preferredName,
    topics: SpeakerInputSchema.shape.topics,
    bio: SpeakerInputSchema.shape.bio,
    links: SpeakerInputSchema.shape.links,
    perEvent: SpeakerInputSchema.shape.perEvent,
    /** How to reach them where email does not apply (yet). No `emails`: an address never goes into git. */
    handles: SpeakerInputSchema.shape.handles.optional(),
  })
  .strict();

export const SeedFileSchema = z
  .object({ speakers: z.array(SeedSpeakerSchema).min(1) })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.speakers.forEach((s, i) => {
      if (seen.has(s.handle)) {
        ctx.addIssue({
          code: 'custom',
          path: ['speakers', i, 'handle'],
          message: `duplicate handle ${s.handle}`,
        });
      }
      seen.add(s.handle);
    });
  });

export interface SeedResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Loads `<root>/speakers.seed.json` through the speakers repository. Idempotent by handle (a unique
 * index): an existing speaker is updated only when a seeded field changed, otherwise left alone.
 * Fails before writing anything if the corpus manifest references a handle the seed does not define.
 */
export async function seedSpeakers(
  root: string,
  speakers: SpeakersRepository,
): Promise<SeedResult> {
  const raw: unknown = JSON.parse(await readFile(join(root, 'speakers.seed.json'), 'utf8'));
  const seed = SeedFileSchema.parse(raw);
  const { manifest } = await loadCorpus(root);
  const defined = new Set(seed.speakers.map((s) => s.handle));
  const missing = [
    ...new Set(manifest.documents.flatMap((d) => (d.speaker ? [d.speaker] : []))),
  ].filter((h) => !defined.has(h));
  if (missing.length > 0) {
    throw new CorpusError(
      missing.map(
        (h) => `the manifest references speaker "${h}", which speakers.seed.json does not define`,
      ),
    );
  }

  const result: SeedResult = { created: [], updated: [], unchanged: [] };
  for (const s of seed.speakers) {
    const wanted: SpeakerInput = {
      handle: s.handle,
      name: s.name,
      topics: s.topics,
      links: s.links,
      perEvent: s.perEvent,
      emails: [],
      handles: s.handles ?? {},
      ...(s.bio === undefined ? {} : { bio: s.bio }),
      ...(s.preferredName === undefined ? {} : { preferredName: s.preferredName }),
    };
    const existing = await speakers.findByHandle(s.handle);
    if (!existing) {
      await speakers.insert(wanted);
      result.created.push(s.handle);
      continue;
    }
    const changed =
      existing.name !== wanted.name ||
      !same(existing.topics, wanted.topics) ||
      !same(existing.links, wanted.links) ||
      !same(existing.perEvent, wanted.perEvent) ||
      (s.handles !== undefined && !same(existing.handles, s.handles)) ||
      (wanted.bio !== undefined && existing.bio !== wanted.bio) ||
      (wanted.preferredName !== undefined && existing.preferredName !== wanted.preferredName);
    if (!changed) {
      result.unchanged.push(s.handle);
      continue;
    }
    await speakers.updateWithRetry(existing._id, () => ({
      name: wanted.name,
      topics: wanted.topics,
      links: wanted.links,
      perEvent: wanted.perEvent,
      // emails are never in a seed file, so a re-seed leaves the ones a human adopted alone
      ...(s.handles === undefined ? {} : { handles: s.handles }),
      ...(wanted.bio === undefined ? {} : { bio: wanted.bio }),
      ...(wanted.preferredName === undefined ? {} : { preferredName: wanted.preferredName }),
    }));
    result.updated.push(s.handle);
  }
  return result;
}
