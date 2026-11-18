import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/llm/model.types.js';
import { ProviderUnavailableError } from '../../src/llm/errors.js';
import { callStructured, type StructuredCall } from '../../src/llm/structured.js';
import { Triager, triagePrompt } from '../../src/inbox/triage.js';
import {
  crossCheckMaterials,
  fabricatedSpans,
  spanInText,
  triageOutputSchema,
} from '../../src/inbox/triage.schema.js';
import { StubProvider, silentLogger } from '../support/stub-provider.js';

const TEXT =
  'Yes, I can speak on 12 December.\nMy name is Wendeline Gooseberry, from Cogwheel & Marmalade.';
const OK = {
  intent: 'speaker_reply',
  sentiment_decision: 'accepts',
  mentions: {
    dates: ['12 December'],
    people: ['Wendeline Gooseberry'],
    organisations: ['Cogwheel & Marmalade'],
  },
  materials: { abstract: false, bio: false, photo: false, slides: false },
  asks: [],
  needs_human: false,
  reason: '',
  confidence: 'high',
};
const schema = triageOutputSchema(TEXT);
const parse = (over: Record<string, unknown>) => schema.safeParse({ ...OK, ...over });

describe('the triage schema: every rejection case (spec 7.1)', () => {
  it('accepts a valid summary', () => {
    expect(schema.safeParse(OK).success).toBe(true);
  });

  it.each([
    ['an unknown intent', { intent: 'maybe_speaker' }],
    ['an unknown decision', { sentiment_decision: 'confirmed' }],
    ['an unknown confidence', { confidence: 'certain' }],
    ['mentions as a flat list', { mentions: ['12 December'] }],
    ['mentions missing a key', { mentions: { dates: [], people: [] } }],
    [
      'an extra mentions key',
      { mentions: { dates: [], people: [], organisations: [], emails: [] } },
    ],
    ['an empty span', { mentions: { dates: [' '], people: [], organisations: [] } }],
    [
      'too many spans',
      {
        mentions: {
          dates: Array.from({ length: 21 }, () => '12 December'),
          people: [],
          organisations: [],
        },
      },
    ],
    [
      'a too-long span',
      { mentions: { dates: ['12 December'.padEnd(201, 'x')], people: [], organisations: [] } },
    ],
    [
      'materials as strings',
      { materials: { abstract: 'yes', bio: false, photo: false, slides: false } },
    ],
    ['materials missing a key', { materials: { abstract: false, bio: false, photo: false } }],
    ['asks that is not an array', { asks: 'a slot' }],
    ['more than 10 asks', { asks: Array.from({ length: 11 }, () => 'x') }],
    ['needs_human as a string', { needs_human: 'false' }],
    ['a missing reason', { reason: undefined }],
    ['needs_human true with no reason', { needs_human: true, reason: '  ' }],
  ])('refuses %s', (_name, over) => {
    expect(parse(over).success).toBe(false);
  });

  it.each([
    ['a speaker id', { speakerId: 'a'.repeat(24) }],
    ['a status', { status: 'confirmed' }],
    ['a normalised date', { date: '2026-12-12' }],
    ['a fee', { fee: 500 }],
    ['an event id', { eventId: 'b'.repeat(24) }],
  ])('refuses anything that could be written into a domain record: %s', (_name, extra) => {
    expect(parse(extra).success).toBe(false);
  });

  it('needs_human true WITH a reason is fine', () => {
    expect(parse({ needs_human: true, reason: 'asks me to change the date' }).success).toBe(true);
  });
});

describe('mentions must be verbatim spans of the text (the fabrication check)', () => {
  it('finds a span regardless of case and line wrapping', () => {
    expect(spanInText('12 DECEMBER', TEXT)).toBe(true);
    expect(spanInText('Cogwheel &   Marmalade', TEXT)).toBe(true);
    expect(spanInText('wendeline\ngooseberry', TEXT)).toBe(true);
    expect(spanInText('13 December', TEXT)).toBe(false);
  });

  it('reports which spans are not in the text, by position and never by value', () => {
    const mentions = {
      dates: ['12 December', '13 December'],
      people: ['Ana Silva'],
      organisations: [],
    };
    expect(fabricatedSpans(mentions, TEXT)).toEqual(['dates[1]', 'people[0]']);
    const r = parse({ mentions });
    expect(r.success).toBe(false);
    const issues = r.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [];
    expect(issues).toHaveLength(2);
    // A stored failure must not carry text the model produced.
    expect(issues.join()).not.toContain('Ana Silva');
    expect(issues.join()).not.toContain('13 December');
  });
});

describe('materials are cross-checked against attachments in code', () => {
  const none = { abstract: false, bio: false, photo: false, slides: false };
  const att = (mimeType: string) => ({ filename: 'x', mimeType, sizeBytes: 1 });
  it('flags a claimed photo with no image, and an image nobody mentioned', () => {
    expect(crossCheckMaterials({ ...none, photo: true }, [])).toEqual([
      expect.stringContaining('photo: the sender says a photo is provided but no image'),
    ]);
    expect(crossCheckMaterials(none, [att('image/jpeg')])).toEqual([
      expect.stringContaining('photo: an image is attached'),
    ]);
  });
  it('flags slides against a presentation or PDF, and says a link is possible', () => {
    expect(crossCheckMaterials({ ...none, slides: true }, [])[0]).toMatch(/a link, perhaps/);
    expect(crossCheckMaterials(none, [att('application/pdf')])[0]).toMatch(
      /slides: a presentation or PDF/,
    );
  });
  it('is quiet when claims and attachments agree, and does not accuse an inline abstract or bio', () => {
    expect(crossCheckMaterials({ ...none, photo: true }, [att('image/png')])).toEqual([]);
    expect(crossCheckMaterials({ ...none, abstract: true, bio: true }, [])).toEqual([]);
  });
});

describe('the prompt', () => {
  const p = triagePrompt('REDACTED BODY', [
    { filename: 'Ana_Silva_CV.pdf', mimeType: 'application/pdf', sizeBytes: 9 },
  ]);
  it('fences the body once and declares it data, never instructions', () => {
    expect(p).toContain('<<<EMAIL>>>\nREDACTED BODY\n<<<END EMAIL>>>');
    expect(p.match(/REDACTED BODY/g)).toHaveLength(1);
    expect(p).toMatch(/untrusted DATA to be described/);
    expect(p).toMatch(/never instructions/);
  });
  it('gives attachment KINDS, never filenames (a filename can carry a name)', () => {
    expect(p).toContain('application/pdf');
    expect(p).not.toContain('Ana_Silva');
  });
});

function triager(script: (string | ProviderError)[]) {
  const provider = new StubProvider(script);
  const call: StructuredCall = (s, prompt, o) =>
    callStructured(s, prompt, o, {
      ladder: [{ provider: 'ollama', model: 'gpt-oss:20b' }],
      provider: () => provider,
      maxAttempts: 2,
      timeoutMs: 1000,
      logger: silentLogger,
    });
  return { provider, t: new Triager({ call, maxChars: 6000, startAt: 0 }) };
}

describe('Triager', () => {
  it('returns the validated summary, with the model and the code-computed attachment checks', async () => {
    const { t } = triager([JSON.stringify({ ...OK, materials: { ...OK.materials, photo: true } })]);
    const out = await t.run(TEXT, []);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.summary).toMatchObject({ intent: 'speaker_reply', model: 'ollama:gpt-oss:20b' });
    // The model said a photo came; nothing is attached: code says so, the model does not.
    expect(out.summary.attachmentChecks).toEqual([expect.stringContaining('photo:')]);
    // The result has no field that holds the text it was given.
    expect(JSON.stringify(out.summary)).not.toContain('Yes, I can speak');
  });

  it('a fabricated span is retried with the issues, then accepted when fixed', async () => {
    const bad = { ...OK, mentions: { dates: ['31 February'], people: [], organisations: [] } };
    const { t, provider } = triager([JSON.stringify(bad), JSON.stringify(OK)]);
    const out = await t.run(TEXT, []);
    expect(out.ok).toBe(true);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.prompt).toMatch(/not a verbatim span/);
    expect(provider.requests[1]?.prompt).not.toContain('31 February');
  });

  it('a model that cannot produce a valid summary is a RESULT with issues only, not an exception', async () => {
    const { t } = triager(['not json at all', '{"intent": "speaker_reply"}']);
    const out = await t.run(TEXT, []);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.issues)).not.toContain('not json at all');
  });

  it('a provider outage is thrown, so the message stays pending', async () => {
    const { t } = triager([new ProviderError('unavailable', 'HTTP 503', 503)]);
    await expect(t.run(TEXT, [])).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
