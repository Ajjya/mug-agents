import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFacts } from '../../src/agents/speakers/drafting.js';
import { SpeakerInputSchema } from '../../src/domain/speaker.schema.js';
import { seedSpeakers } from '../../src/retrieval/seed-speakers.js';
import { InMemorySpeakersRepository } from '../support/in-memory.repositories.js';
import { SAMPLE } from '../support/store-suite.js';

const EVENT = {
  _id: 'a'.repeat(24),
  title: 'Winter Meetup',
  date: '2026-12-12T00:00:00.000Z',
  agenda: [],
};
const facts = (speaker: { name: string; preferredName?: string }) =>
  buildFacts({
    event: EVENT,
    speaker: { _id: 'd'.repeat(24), ...speaker },
    venue: null,
    kind: 'invitation',
    now: new Date('2026-11-01T09:00:00Z'),
    replyDays: 7,
    timeZone: 'Europe/Lisbon',
  }).speaker_name;

describe('preferredName', () => {
  it('is optional and cannot be blank', () => {
    const base = { name: 'A', topics: [], links: {}, perEvent: [] };
    expect(SpeakerInputSchema.safeParse(base).success).toBe(true);
    expect(SpeakerInputSchema.safeParse({ ...base, preferredName: 'Al' }).success).toBe(true);
    expect(SpeakerInputSchema.safeParse({ ...base, preferredName: '  ' }).success).toBe(false);
  });

  it('is the greeting name when present, else the full name exactly as stored', () => {
    expect(facts({ name: 'Ana Maria de Souza e Silva', preferredName: 'Ana' })).toBe('Ana');
    // No guessing: a long, multi-part name is used whole, never cut to a "first name".
    expect(facts({ name: 'Ana Maria de Souza e Silva' })).toBe('Ana Maria de Souza e Silva');
    expect(facts({ name: 'Nguyễn Thị Minh Khai' })).toBe('Nguyễn Thị Minh Khai');
  });

  it('seeds from the seed file, and a change is an update (a human wrote it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-pref-'));
    cpSync(SAMPLE, dir, { recursive: true });
    const file = join(dir, 'speakers.seed.json');
    const seed = JSON.parse(readFileSync(file, 'utf8')) as {
      speakers: { handle: string; preferredName?: string }[];
    };
    const first = seed.speakers[0];
    if (!first) throw new Error('sample seed is empty');
    first.preferredName = 'Zee';
    writeFileSync(file, JSON.stringify(seed));
    const repo = new InMemorySpeakersRepository();
    await seedSpeakers(dir, repo);
    expect((await repo.findByHandle(first.handle))?.preferredName).toBe('Zee');
    first.preferredName = 'Zed';
    writeFileSync(file, JSON.stringify(seed));
    expect((await seedSpeakers(dir, repo)).updated).toEqual([first.handle]);
    expect((await repo.findByHandle(first.handle))?.preferredName).toBe('Zed');
  });
});

describe('no name splitting anywhere', () => {
  function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) yield* sources(path);
      else if (path.endsWith('.ts')) yield path;
    }
  }
  // `name.split(`, `speaker.name.split(`, `fullName.split(`, `name.split(' ')[0]`...
  const SPLITS_A_NAME = /\b\w*[nN]ame\s*\??\.\s*split\s*\(/;

  it('src never splits or shortens a person name', () => {
    const offenders = [...sources('src')].filter((f) =>
      SPLITS_A_NAME.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    ['speaker.name.split(" ")[0]', true],
    ["const first = fullName.split(' ')", true],
    ['p.preferredName?.split(",")', true],
    ['const parts = line.split(",")', false],
    ['venue.address.split("\\n")', false],
  ])('the matcher: %s', (source, hit) => {
    expect(SPLITS_A_NAME.test(source)).toBe(hit);
  });
});
