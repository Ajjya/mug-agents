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
