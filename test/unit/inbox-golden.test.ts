import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOLDEN_FIELDS,
  GoldenFileSchema,
  GoldenNotVerifiedError,
  UntrackedPathRequiredError,
  assertEvaluable,
  assertNotTracked,
  checkGolden,
  exportGolden,
  loadGolden,
} from '../../src/inbox/golden.js';
import type { Triager } from '../../src/inbox/triage.js';
import { inboundInput } from '../support/inbox-fixtures.js';
import {
  InMemoryContactsRepository,
  InMemoryExcludedThreadsRepository,
  InMemoryInboundMessagesRepository,
  InMemoryOrganisationsRepository,
  InMemorySpeakersRepository,
} from '../support/in-memory.repositories.js';

const SAMPLE = 'corpus/sample/inbox-golden';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'golden-'));

const goodFile = () => ({
  id: 'x1',
  source: 'fictional',
  seededBy: 'hand',
  attachments: [],
  body: 'Hello there',
  expected: {
    intent: { value: 'other', status: 'verified' },
    sentiment_decision: { value: 'unclear', status: 'verified' },
    materials: {
      value: { abstract: false, bio: false, photo: false, slides: false },
      status: 'verified',
    },
    needs_human: { value: false, status: 'verified' },
  },
});

describe('the golden file schema', () => {
  it('accepts a good file', () => {
    expect(GoldenFileSchema.safeParse(goodFile()).success).toBe(true);
  });
  it.each([
    ['an unknown field', { extra: 1 }],
    ['an empty body', { body: '' }],
    ['an unknown source', { source: 'imagined' }],
    ['no seededBy', { seededBy: '' }],
    ['a bare label without a status', { expected: { ...goodFile().expected, intent: 'other' } }],
    [
      'an unknown status',
      { expected: { ...goodFile().expected, needs_human: { value: false, status: 'probably' } } },
    ],
    [
      'an unknown intent',
      { expected: { ...goodFile().expected, intent: { value: 'maybe', status: 'verified' } } },
    ],
    ['a missing label', { expected: { intent: goodFile().expected.intent } }],
  ])('refuses %s', (_name, over) => {
    expect(GoldenFileSchema.safeParse({ ...goodFile(), ...over }).success).toBe(false);
  });
});

describe('the committed sample set (what CI and a fresh clone run)', () => {
  const check = checkGolden(SAMPLE);
  const set = loadGolden(SAMPLE);

  it('is fully verified, valid, and 8-15 messages', () => {
    expect(check.problems).toEqual([]);
    expect(check.unverified).toBe(0);
    expect(check.ok).toBe(true);
    expect(check.files).toBeGreaterThanOrEqual(8);
    expect(check.files).toBeLessThanOrEqual(15);
  });

  it('has at least one injection message and one that must come out needs_human', () => {
    const injection = set.filter((s) => /ignore your previous instructions/i.test(s.golden.body));
    expect(injection.length).toBeGreaterThanOrEqual(1);
    expect(injection.every((s) => s.golden.expected.needs_human.value)).toBe(true);
    const needsHuman = set.filter(
      (s) => s.golden.expected.needs_human.value && !injection.includes(s),
    );
    expect(needsHuman.length).toBeGreaterThanOrEqual(1);
  });

  it('is fictional: every file says so, and the only addresses are on invalid domains', () => {
    for (const { name, golden } of set) {
      expect(golden.source, name).toBe('fictional');
      for (const m of golden.body.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
        expect(m[0], name).toMatch(/\.invalid$/);
      }
    }
  });

  it('reports the class counts and the majority-class baseline', () => {
    expect(check.intentCounts).toMatchObject({
      speaker_reply: 5,
      venue_reply: 1,
      sponsor_enquiry: 1,
      cohost_reply: 1,
      coorganiser: 1,
      community_manager: 1,
      calendar_invite: 1,
      document_share: 1,
    });
    expect(check.majority).toEqual({ intent: 'speaker_reply', count: 5, share: 5 / 15 });
  });

  it('keeps quoted history and signatures in the bodies, so the eval exercises the real redaction', () => {
    expect(set.some((s) => /wrote:\n>/.test(s.golden.body))).toBe(true);
    expect(set.some((s) => /\n-- \n/.test(s.golden.body))).toBe(true);
  });
});

describe('check-golden and the eval gate', () => {
  function dirWith(files: Record<string, unknown>): string {
    const d = tmp();
    for (const [n, v] of Object.entries(files))
      writeFileSync(join(d, n), typeof v === 'string' ? v : JSON.stringify(v));
    return d;
  }
  const unverified = (id: string, fields: string[]) => {
    const g = goodFile() as { id: string; expected: Record<string, { status: string }> };
    g.id = id;
    for (const f of fields) g.expected[f] = { ...g.expected[f], status: 'unverified' };
    return g;
  };

  it('counts unverified fields per file and refuses the eval', () => {
    const d = dirWith({
      'a.json': unverified('a', ['intent', 'needs_human']),
      'b.json': unverified('b', []),
      'c.json': unverified('c', ['materials']),
    });
    const c = checkGolden(d);
    expect(c).toMatchObject({ files: 3, unverified: 3, ok: false });
    expect(c.perFile.find((f) => f.name === 'a.json')?.unverified).toEqual([
      'intent',
      'needs_human',
    ]);
    expect(() => {
      assertEvaluable(c);
    }).toThrow(GoldenNotVerifiedError);
    expect(() => {
      assertEvaluable(c);
    }).toThrow(/3 golden label\(s\) are still "unverified".*grading itself/s);
  });

  it('reports invalid JSON, schema problems and duplicate ids; none of them is evaluable', () => {
    const d = dirWith({
      'a.json': unverified('same', []),
      'b.json': unverified('same', []),
      'c.json': '{ not json',
      'd.json': { id: 'd' },
    });
    const c = checkGolden(d);
    expect(c.ok).toBe(false);
    expect(c.problems.join('\n')).toMatch(/c\.json: not valid JSON/);
    expect(c.problems.join('\n')).toMatch(/d\.json:/);
    expect(c.problems.join('\n')).toMatch(/duplicate ids/);
    expect(() => {
      assertEvaluable(c);
    }).toThrow(/invalid file/);
  });

  it('an empty or missing directory is not an evaluable set', () => {
    expect(checkGolden(tmp()).ok).toBe(false);
    expect(() => {
      assertEvaluable(checkGolden(tmp()));
    }).toThrow(/empty/);
    expect(checkGolden(join(tmp(), 'nope')).problems[0]).toMatch(/does not exist/);
  });

  it('a fully verified set passes', () => {
    const c = checkGolden(dirWith({ 'a.json': unverified('a', []) }));
    expect(c.ok).toBe(true);
    expect(() => {
      assertEvaluable(c);
    }).not.toThrow();
  });
});

describe('export-golden', () => {
  const stubTriager = (calls: string[] = []) =>
    ({
      run: (body: string) => {
        calls.push(body);
        // Verbatim spans only, as a real model's must be: a name appears only if the text has it.
        return Promise.resolve({
          ok: true,
          calls: [],
          summary: {
            intent: 'speaker_reply',
            sentiment_decision: 'accepts',
            mentions: {
              dates: body.includes('12 December') ? ['12 December'] : [],
              people: body.includes('Ana Costa') ? ['Ana Costa'] : [],
              organisations: body.includes('Real Employer plc') ? ['Real Employer plc'] : [],
            },
            materials: { abstract: false, bio: false, photo: true, slides: false },
            asks: [],
            needs_human: false,
            reason: '',
            confidence: 'high',
            attachmentChecks: [],
            model: 'ollama:gpt-oss:20b',
          },
        });
      },
    }) as unknown as Triager;

  async function world() {
    const inbound = new InMemoryInboundMessagesRepository();
    const speakers = new InMemorySpeakersRepository();
    const organisations = new InMemoryOrganisationsRepository();
    const contacts = new InMemoryContactsRepository();
    const excluded = new InMemoryExcludedThreadsRepository();
    await speakers.insert({
      name: 'Rui Alves',
      emails: ['rui@real-speakers.com'],
      handles: {},
      topics: [],
      links: {},
      perEvent: [],
    });
    await organisations.insert({
      name: 'Real Employer plc',
      kind: 'company',
      contacts: [],
      history: [],
    });
    await inbound.insert(
      inboundInput({
        gmailId: 'g-1',
        threadId: 't-1',
        from: { name: 'Ana Costa', address: 'ana.costa@real-employer.com' },
        bodyText:
          'Hi, Ana Costa from Real Employer plc. Yes, I can speak on 12 December. Call +351 912 345 678.\n\n-- \nAna Costa\nTel +351 912 345 678',
        attachments: [
          { filename: 'Ana_Costa_CV.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
        ],
      }),
    );
    await inbound.insert(
      inboundInput({
        gmailId: 'g-2',
        threadId: 't-2',
        from: { name: 'Rui Alves', address: 'rui@real-speakers.com' },
        bodyText: 'Hello. Ana Costa suggested I write. Regards, Rui Alves',
        bodyRedacted: 'Hello. Ana Costa suggested I write. Regards, Rui Alves',
        triageState: 'pending',
      }),
    );
    return { inbound, speakers, organisations, contacts, excluded };
  }

  it('writes anonymised files with every label unverified, the seeding model, and no real name or address', async () => {
    const w = await world();
    const out = tmp();
    const report = await exportGolden({ ...w, triager: stubTriager() }, { outDir: out });
    expect(report.written).toEqual(['g001', 'g002']);
    const files = loadGolden(out);
    expect(files).toHaveLength(2);
    const all = readdirSync(out)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.')) // the mapping holds real names, by design
      .map((f) => readFileSync(join(out, f), 'utf8'))
      .join('\n');
    expect(all).not.toMatch(
      /Ana Costa|Rui Alves|Real Employer|real-employer|real-speakers|Ana_Costa|\+351 912/i,
    );
    for (const { golden } of files) {
      expect(golden).toMatchObject({ source: 'real', seededBy: 'ollama:gpt-oss:20b' });
      for (const f of GOLDEN_FIELDS) expect(golden.expected[f].status).toBe('unverified');
    }
    expect(files[0]?.golden.attachments[0]?.filename).toBe('attachment-1.pdf'); // a name can hide in a filename; the type stays
    const c = checkGolden(out);
    expect(c).toMatchObject({ files: 2, unverified: 8, ok: false }); // 4 fields x 2: not evaluable until corrected
    expect(() => {
      assertEvaluable(c);
    }).toThrow(GoldenNotVerifiedError);
  });

  it('the same person is the same pseudonym in every message, and the proposed mentions stay verbatim spans', async () => {
    const w = await world();
    const out = tmp();
    await exportGolden({ ...w, triager: stubTriager() }, { outDir: out });
    const [one, two] = loadGolden(out).map((f) => f.golden);
    const anaIn1 = /Hi, (.+?) from (.+?)\./.exec(one?.body ?? '');
    expect(anaIn1?.[1]).toBeDefined();
    expect(two?.body).toContain(anaIn1?.[1] ?? '!'); // Ana is mentioned in message 2 too: same pseudonym
    for (const g of [one, two]) {
      for (const span of g?.proposedMentions?.people ?? [])
        expect(g?.body.toLowerCase()).toContain(span.toLowerCase());
      for (const span of g?.proposedMentions?.organisations ?? [])
        expect(g?.body.toLowerCase()).toContain(span.toLowerCase());
    }
  });

  it('keeps the mapping out of band: written, private (0600), and holding the real names it replaces', async () => {
    const w = await world();
    const out = tmp();
    await exportGolden({ ...w, triager: stubTriager() }, { outDir: out });
    const mapping = join(out, '.pseudonyms.json');
    expect(statSync(mapping).mode & 0o777).toBe(0o600);
    expect(readFileSync(mapping, 'utf8')).toContain('Ana Costa');
    expect(readdirSync(out).filter((f) => f.endsWith('.json') && !f.startsWith('.'))).toHaveLength(
      2,
    ); // the mapping is not a golden file
  });

  it('a re-run exports nothing twice, and NEVER overwrites a file a human has corrected', async () => {
    const w = await world();
    const out = tmp();
    await exportGolden({ ...w, triager: stubTriager() }, { outDir: out });
    expect(
      (await exportGolden({ ...w, triager: stubTriager() }, { outDir: out }))
        .skippedAlreadyExported,
    ).toBe(2);

    // The human corrects and verifies g001.
    const path = join(out, 'g001.json');
    const edited = JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof goodFile>;
    edited.expected.intent = { value: 'venue_reply', status: 'verified' };
    writeFileSync(path, JSON.stringify(edited));

    // Even when the mapping forgets what was exported (say it was deleted), the file survives.
    const mapping = join(out, '.pseudonyms.json');
    const m = JSON.parse(readFileSync(mapping, 'utf8')) as { exported: Record<string, string> };
    m.exported = {};
    writeFileSync(mapping, JSON.stringify(m));
    const again = await exportGolden({ ...w, triager: stubTriager() }, { outDir: out });
    expect(again.skippedExisting).toBe(2);
    expect(again.written).toEqual([]);
    expect((JSON.parse(readFileSync(path, 'utf8')) as typeof edited).expected.intent).toEqual({
      value: 'venue_reply',
      status: 'verified',
    });
  });

  it('uses the stored triage when there is one, and runs triage only for what lacks it', async () => {
    const w = await world();
    const calls: string[] = [];
    await exportGolden({ ...w, triager: stubTriager(calls) }, { outDir: tmp() });
    expect(calls).toHaveLength(2); // neither fixture message had a stored summary: both were triaged, on the stored REDACTED text
    expect(calls.join()).not.toContain('Tel +351');
  });

  it('an EXCLUDED thread is not exported: not read, not triaged, not copied (review finding)', async () => {
    const w = await world();
    await w.excluded.insert({
      threadId: 't-1',
      reason: 'not MUG',
      excludedAt: '2026-11-01T00:00:00.000Z',
      status: 'excluded',
    });
    const calls: string[] = [];
    const out = tmp();
    const report = await exportGolden({ ...w, triager: stubTriager(calls) }, { outDir: out });
    expect(report.skippedExcluded).toBe(1);
    expect(report.written).toHaveLength(1); // only t-2
    expect(calls).toHaveLength(1);
    expect(calls.join()).not.toContain('Real Employer'); // t-1's text never reached the triager
    expect(w.inbound.rawBodyReads).toHaveLength(1); // and its raw body was never even read
  });

  it('with no proposal at all, the safe proposal is "a human should look"', async () => {
    const w = await world();
    const failing = {
      run: () => Promise.resolve({ ok: false, issues: ['x'], calls: [] }),
    } as unknown as Triager;
    const out = tmp();
    await exportGolden({ ...w, triager: failing }, { outDir: out });
    const g = loadGolden(out)[0]?.golden;
    expect(g?.expected.needs_human).toEqual({ value: true, status: 'unverified' });
    expect(g?.seededBy).toMatch(/none/);
  });
});

describe('real mail is only written where git ignores it', () => {
  it('a path inside the repository that git does not ignore is refused', () => {
    expect(() => {
      assertNotTracked('src/zz-golden-output');
    }).toThrow(UntrackedPathRequiredError);
    expect(() => {
      assertNotTracked('corpus/sample/inbox-golden-real');
    }).toThrow(UntrackedPathRequiredError);
  });
  it('corpus/private and anything outside the repository are fine', () => {
    expect(() => {
      assertNotTracked('corpus/private/inbox-golden');
      assertNotTracked(join(tmpdir(), 'anywhere'));
    }).not.toThrow();
  });
  it('export-golden refuses a tracked output or mapping path before reading anything', async () => {
    const w = {
      inbound: new InMemoryInboundMessagesRepository(),
      speakers: new InMemorySpeakersRepository(),
      organisations: new InMemoryOrganisationsRepository(),
      contacts: new InMemoryContactsRepository(),
      excluded: new InMemoryExcludedThreadsRepository(),
      triager: { run: () => Promise.reject(new Error('must not run')) } as unknown as Triager,
    };
    await expect(exportGolden(w, { outDir: 'src/zz-golden-output' })).rejects.toBeInstanceOf(
      UntrackedPathRequiredError,
    );
    await expect(
      exportGolden(w, { outDir: tmp(), mappingPath: 'src/zz-map.json' }),
    ).rejects.toBeInstanceOf(UntrackedPathRequiredError);
  });
});
