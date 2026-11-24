import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseDelivery } from '../../src/agents/speakers/delivery.js';
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
    kind: 'chase_reply',
    now: new Date('2026-11-01T09:00:00Z'),
    replyDays: 7,
    timeZone: 'Europe/Lisbon',
  }).speaker_name;

describe('preferredName', () => {
  it('is optional and cannot be blank', () => {
    const base = { name: 'A', emails: [], handles: {}, topics: [], links: {}, perEvent: [] };
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

describe('a LinkedIn URL has one home: handles.linkedin', () => {
  const entry = (over: Record<string, unknown>) => ({
    handle: 'ana-pires',
    name: 'Ana Pires',
    topics: [],
    links: {},
    perEvent: [],
    ...over,
  });

  it('a seed with links.linkedin (and nothing in handles) leaves the speaker reachable as manual:linkedin', async () => {
    // the sample corpus manifest references other handles: seed those too (unchanged) by keeping the sample
    const dir = mkdtempSync(join(tmpdir(), 'seed-li-'));
    cpSync(SAMPLE, dir, { recursive: true });
    const file = join(dir, 'speakers.seed.json');
    const seed = JSON.parse(readFileSync(file, 'utf8')) as { speakers: Record<string, unknown>[] };
    seed.speakers.push(
      entry({
        links: { linkedin: 'https://linkedin.com/in/ana-pires', github: 'https://github.com/ana' },
      }),
    );
    writeFileSync(file, JSON.stringify(seed));
    const repo = new InMemorySpeakersRepository();
    await seedSpeakers(dir, repo);
    const ana = await repo.findByHandle('ana-pires');
    expect(ana?.handles).toEqual({ linkedin: 'https://linkedin.com/in/ana-pires' });
    expect(ana?.links).toEqual({ github: 'https://github.com/ana' }); // links keeps only github and website
    expect(chooseDelivery(ana ?? { emails: [], handles: {} })).toBe('manual:linkedin');
    // re-seeding is a no-op
    expect((await seedSpeakers(dir, repo)).updated).toEqual([]);
  });

  const withEntry = (e: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-li-'));
    cpSync(SAMPLE, dir, { recursive: true });
    const file = join(dir, 'speakers.seed.json');
    const seed = JSON.parse(readFileSync(file, 'utf8')) as { speakers: Record<string, unknown>[] };
    seed.speakers.push(e);
    writeFileSync(file, JSON.stringify(seed));
    return dir;
  };

  it('an entry with BOTH values, identical, loads and ends up with ONE handle', async () => {
    const url = 'https://www.linkedin.com/in/ana-pires/';
    const dir = withEntry(entry({ links: { linkedin: url }, handles: { linkedin: url } }));
    const repo = new InMemorySpeakersRepository();
    await seedSpeakers(dir, repo);
    const ana = await repo.findByHandle('ana-pires');
    expect(ana?.handles).toEqual({ linkedin: url });
    expect(ana?.links).toEqual({}); // links keeps only github and website in the database
    expect(chooseDelivery(ana ?? { emails: [], handles: {} })).toBe('manual:linkedin');
  });

  it('an entry with BOTH values that DIFFER fails loudly, naming the speaker, and writes nothing', async () => {
    const dir = withEntry(
      entry({
        links: { linkedin: 'https://linkedin.com/in/old' },
        handles: { linkedin: 'https://linkedin.com/in/new' },
      }),
    );
    const repo = new InMemorySpeakersRepository();
    await expect(seedSpeakers(dir, repo)).rejects.toThrow(
      /speaker ana-pires: links\.linkedin \(https:\/\/linkedin\.com\/in\/old\) and handles\.linkedin \(https:\/\/linkedin\.com\/in\/new\) differ/,
    );
    expect(await repo.findByHandle('ana-pires')).toBeNull();
    expect(await repo.count()).toBe(0); // nothing at all was written
  });

  it('a handle a human already has is never overwritten by a re-seed that only has links.linkedin', async () => {
    const dir = withEntry(entry({ links: { linkedin: 'https://linkedin.com/in/from-links' } }));
    const repo = new InMemorySpeakersRepository();
    const ana = await repo.insert({
      handle: 'ana-pires',
      name: 'Ana Pires',
      emails: [],
      handles: { linkedin: 'https://linkedin.com/in/humans' },
      topics: [],
      links: {},
      perEvent: [],
    });
    await seedSpeakers(dir, repo);
    expect((await repo.findById(ana._id))?.handles.linkedin).toBe('https://linkedin.com/in/humans');
  });

  it('the stored schema no longer accepts links.linkedin: one home, enforced', () => {
    const base = { name: 'A', emails: [], handles: {}, topics: [], perEvent: [] };
    expect(
      SpeakerInputSchema.safeParse({ ...base, links: { linkedin: 'https://x.invalid' } }).success,
    ).toBe(false);
    expect(
      SpeakerInputSchema.safeParse({ ...base, links: { github: 'https://github.com/a' } }).success,
    ).toBe(true);
  });
});
