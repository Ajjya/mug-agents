import { describe, expect, it } from 'vitest';
import { Pseudonymiser, PseudonymMapSchema, emptyMap } from '../../src/inbox/anonymise.js';

describe('Pseudonymiser: stable, fictional, consistent (spec 8)', () => {
  it('the same person is the same pseudonym every time, and across instances loaded from the map', () => {
    const a = new Pseudonymiser();
    const p1 = a.person('Ana Costa');
    expect(a.person('Ana Costa')).toBe(p1);
    expect(a.person('  Ana Costa ')).toBe(p1);
    expect(a.person('Rui Alves')).not.toBe(p1);
    const b = new Pseudonymiser(PseudonymMapSchema.parse(JSON.parse(JSON.stringify(a.map))));
    expect(b.person('Ana Costa')).toBe(p1);
    expect(b.person('Rui Alves')).toBe(a.person('Rui Alves'));
  });

  it('is deterministic: the same real names in the same order give the same pseudonyms', () => {
    const run = () => {
      const p = new Pseudonymiser();
      return [p.person('A One'), p.person('B Two'), p.organisation('Acme'), p.address('A@B.com')];
    };
    expect(run()).toEqual(run());
  });

  it('pseudonyms are obviously fictional, distinct, and addresses end in .invalid', () => {
    const p = new Pseudonymiser();
    const names = Array.from({ length: 40 }, (_, i) => p.person(`Real Person ${String(i)}`));
    expect(new Set(names).size).toBe(40);
    expect(p.address('x@y.com')).toMatch(/^person\d+@example\.invalid$/);
    expect(p.organisation('Real Employer plc')).toMatch(
      /Ltd\.|Analytics|Works|Daughters|Systems|Studios|Co\.|Software|Logistics|Data/,
    );
  });

  it('text() replaces names, organisations and every email address, case-insensitively', () => {
    const p = new Pseudonymiser();
    p.learn('person', 'Ana Costa');
    p.learn('organisation', 'Real Employer plc');
    const out = p.text(
      'Hi, ANA COSTA from Real Employer plc here (ana.costa@real-employer.com). Cheers, ana costa',
    );
    expect(out).not.toMatch(/Ana Costa|Real Employer|real-employer/i);
    expect(out).toContain(p.person('Ana Costa'));
    expect(out).toContain(p.organisation('Real Employer plc'));
    expect(out).toContain(p.address('ana.costa@real-employer.com'));
    expect(out.split(p.person('Ana Costa'))).toHaveLength(3); // both mentions, whatever the case
  });

  it('longest first: "Ana Costa" is replaced as a whole, not as "Ana" plus a stray "Costa"', () => {
    const p = new Pseudonymiser();
    p.learn('person', 'Ana');
    p.learn('person', 'Ana Costa');
    const out = p.text('Ana Costa wrote. Ana agreed.');
    expect(out).toBe(`${p.person('Ana Costa')} wrote. ${p.person('Ana')} agreed.`);
  });

  it('a pseudonym is never re-matched by a later, shorter real name', () => {
    // The pseudonym of "Ana Costa" is "Wendeline Gooseberry". If "Wendeline" is ALSO a real name in the
    // mapping, the first replacement must not be corrupted by the second.
    const p = new Pseudonymiser({
      people: { 'Ana Costa': 'Wendeline Gooseberry', Wendeline: 'Zara Quillfeather' },
      organisations: {},
      addresses: {},
    });
    expect(p.text('Ana Costa and Wendeline met.')).toBe(
      'Wendeline Gooseberry and Zara Quillfeather met.',
    );
  });

  it('does not touch a name inside a longer word', () => {
    const p = new Pseudonymiser();
    p.learn('person', 'Ana');
    expect(p.text('Banana and Anatolia, but Ana yes.')).toBe(
      `Banana and Anatolia, but ${p.person('Ana')} yes.`,
    );
  });

  it('a name with regex metacharacters is matched literally', () => {
    const p = new Pseudonymiser();
    p.learn('organisation', 'C++ (Lisbon) Users');
    expect(p.text('The C++ (Lisbon) Users group')).toContain(p.organisation('C++ (Lisbon) Users'));
  });

  it('also masks phone numbers and postal address lines, and keeps quoted history (redaction handles that later)', () => {
    const p = new Pseudonymiser();
    const out = p.text(
      'Call +351 912 345 678.\nRua das Flores 12\n1000-001 Lisboa\n> quoted line stays',
    );
    expect(out).toBe('Call [phone].\n[address]\n[address]\n> quoted line stays');
  });

  it('the map can be written and read back (strict)', () => {
    const m = emptyMap();
    expect(PseudonymMapSchema.parse(m)).toEqual(m);
    expect(() => PseudonymMapSchema.parse({ ...m, extra: 1 })).toThrow();
  });
});

describe('addresses hidden where the plain pattern cannot see them (URLs and encoded blobs)', () => {
  const ADDRESS = 'yashraj.nayak@mongodb.com';
  const b64 = Buffer.from(ADDRESS).toString('base64');
  const b64url = Buffer.from(ADDRESS).toString('base64url');
  const double = Buffer.from(b64).toString('base64');
  const pct = ADDRESS.replace('@', '%40');
  /** Every encoding the address could come back in. */
  const FORMS = [
    ADDRESS,
    ADDRESS.toUpperCase(),
    pct,
    b64,
    b64.replace(/=+$/, ''),
    b64url,
    double,
    Buffer.from(ADDRESS).toString('hex'),
  ];

  const body = [
    'You have been invited to MUG Lisbon.',
    `View in calendar: https://www.google.com/calendar/event?action=VIEW&eid=abc&tok=${b64url}&ctz=Europe%2FLisbon&hl=en&es=1&mark_sender_as_known=${b64}`,
    `Unsubscribe: https://example.invalid/u/${b64url}/confirm`,
    `Reply to ${pct} or use this code: ${double}`,
    `Reference blob on its own line:\n${b64}`,
    `Spelled out: ${Buffer.from(ADDRESS).toString('hex')}`,
    'Plain: write to someone@example.com for help.',
  ].join('\n');

  it('a known address base64-encoded in a URL parameter is gone after anonymising, in every encoding', () => {
    const out = new Pseudonymiser().text(body);
    for (const form of FORMS) {
      expect(out, form).not.toContain(form);
      expect(out.toLowerCase(), form).not.toContain(form.toLowerCase());
    }
    expect(out).not.toMatch(/yashraj|nayak|mongodb/i);
  });

  it('strips query strings but keeps scheme, host and path (the message still reads as a calendar link)', () => {
    const out = new Pseudonymiser().text(body);
    expect(out).toContain('https://www.google.com/calendar/event');
    expect(out).not.toMatch(/tok=|mark_sender_as_known=|eid=abc|ctz=/);
  });

  it('a base64 blob in the PATH (no query string to strip) is still caught by decoding it', () => {
    const out = new Pseudonymiser().text(
      `Unsubscribe: https://example.invalid/u/${b64url}/confirm`,
    );
    expect(out).not.toContain(b64url);
    expect(out).toContain('https://example.invalid/u/');
    expect(out).toContain('/confirm');
  });

  it('leaves ordinary long words and plain base64 that is not an address alone, and still pseudonymises plain addresses', () => {
    const harmless = Buffer.from('a perfectly ordinary sentence with no address in it').toString(
      'base64',
    );
    const p = new Pseudonymiser();
    const out = p.text(`Internationalisationconsiderations ${harmless} and someone@example.com`);
    expect(out).toContain('Internationalisationconsiderations');
    expect(out).toContain(harmless);
    expect(out).not.toContain('someone@example.com');
    expect(out).toMatch(/person1@example\.invalid/);
  });

  it('the same address, found plain and found percent-encoded, is the same pseudonym', () => {
    const p = new Pseudonymiser();
    const out = p.text(`${ADDRESS} then ${pct}`);
    const pseudonym = p.address(ADDRESS);
    expect(out.split(pseudonym)).toHaveLength(3);
  });
});
