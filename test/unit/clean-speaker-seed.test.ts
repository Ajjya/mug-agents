import { describe, expect, it } from 'vitest';
import { cleanSpeakerSeed } from '../../src/retrieval/clean-speaker-seed.js';

/** Percent-encoding, diacritics, odd key order and indentation: all must survive byte for byte. */
const URL_A = 'https://www.linkedin.com/in/jo%C3%A3o-mendes-9a8b7c/';
const URL_B = 'https://www.linkedin.com/in/ana-pires/';

const FILE = `{
  "speakers": [
    {
      "name": "João Mendes",
      "handle": "joao-mendes",
      "topics": [".NET", "Kafka"],
      "links": {
        "github": "https://github.com/jm",
        "linkedin": "${URL_A}"
      },
      "perEvent": [],
      "handles": {
        "linkedin": "${URL_A}"
      },
      "bio": "Head of Tech — São Paulo"
    },
    {
      "handle": "ana-pires", "name": "Ana Pires", "topics": [], "perEvent": [],
      "links": { "linkedin": "${URL_B}" }
    },
    {
      "handle": "rui-alves", "name": "Rui Alves", "topics": [], "perEvent": [],
      "links": { "linkedin": "https://www.linkedin.com/in/rui/" }, "handles": { "linkedin": "https://www.linkedin.com/in/rui/", "whatsapp": "+351000" }
    }
  ]
}
`;

describe('cleanSpeakerSeed: removes the duplicate LinkedIn URL and nothing else', () => {
  it('removes handles.linkedin where identical to links.linkedin, byte-identical elsewhere', () => {
    const r = cleanSpeakerSeed(FILE);
    expect(r.conflicts).toEqual([]);
    expect(r.removed).toEqual(['joao-mendes', 'rui-alves']);

    // Joao: handles had only linkedin, so the (now empty) member goes with it, and the comma before it.
    const expected = FILE.replace(
      `,
      "handles": {
        "linkedin": "${URL_A}"
      }`,
      '',
    ).replace(
      `"handles": { "linkedin": "https://www.linkedin.com/in/rui/", "whatsapp": "+351000" }`,
      `"handles": { "whatsapp": "+351000" }`,
    );
    // ...leaves "bio" after the removed member: rebuild exactly what we expect for that entry.
    expect(r.text).toBe(expected);
    expect(r.text).toContain(URL_A); // percent-encoding untouched, in links
    expect(r.text).toContain('João Mendes'); // diacritics untouched
    expect(r.text).toContain('São Paulo');
    // Still valid JSON, and the data is what it should be.
    const parsed = JSON.parse(r.text) as { speakers: Record<string, Record<string, unknown>>[] };
    expect(parsed.speakers[0]?.['handles']).toBeUndefined();
    expect((parsed.speakers[0]?.['links'] as Record<string, string>)['linkedin']).toBe(
      'https://www.linkedin.com/in/jo%C3%A3o-mendes-9a8b7c/',
    );
    expect(parsed.speakers[2]?.['handles']).toEqual({ whatsapp: '+351000' });
  });

  it('is idempotent: a second run changes nothing and removes nothing', () => {
    const once = cleanSpeakerSeed(FILE);
    const twice = cleanSpeakerSeed(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.removed).toEqual([]);
    expect(twice.conflicts).toEqual([]);
  });

  it('leaves an entry with only links.linkedin untouched (and a file with nothing to do is returned as is)', () => {
    const only = `{ "speakers": [ { "handle": "ana-pires", "links": { "linkedin": "${URL_B}" } } ] }`;
    const r = cleanSpeakerSeed(only);
    expect(r.text).toBe(only);
    expect(r.removed).toEqual([]);
  });

  it('REFUSES when the two values differ: nothing is removed anywhere, and the speaker is reported', () => {
    const file = FILE.replace(
      `"handles": { "linkedin": "https://www.linkedin.com/in/rui/", "whatsapp": "+351000" }`,
      `"handles": { "linkedin": "https://www.linkedin.com/in/rui-different/" }`,
    );
    const r = cleanSpeakerSeed(file);
    expect(r.text).toBe(file); // even the identical duplicate for joao is left, because the file is not touched
    expect(r.removed).toEqual([]);
    expect(r.conflicts).toEqual([
      {
        speaker: 'rui-alves',
        links: 'https://www.linkedin.com/in/rui/',
        handles: 'https://www.linkedin.com/in/rui-different/',
      },
    ]);
  });

  it('values are compared decoded, so an escaped spelling of the same URL is the same value', () => {
    const file = `{ "speakers": [ { "handle": "x", "links": { "linkedin": "https://a.invalid/\\u00e3" }, "handles": { "linkedin": "https://a.invalid/ã" } } ] }`;
    expect(cleanSpeakerSeed(file).removed).toEqual(['x']);
  });

  it('rejects text that is not JSON instead of guessing', () => {
    expect(() => cleanSpeakerSeed('{ "speakers": [ {')).toThrow(SyntaxError);
  });
});
