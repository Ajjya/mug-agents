import { describe, expect, it } from 'vitest';
import {
  TRUNCATION_MARKER,
  redactForTriage,
  stripQuotedHistory,
  stripSignature,
} from '../../src/inbox/redact.js';

const R = (s: string, max = 6000) => redactForTriage(s, max);

describe('quoted history is stripped', () => {
  it.each([
    [
      'English',
      'Sounds good.\n\nOn Mon, 19 Oct 2026 at 10:00, MUG Organiser <o@mug.invalid> wrote:\n> Would you speak?\n> Thanks',
    ],
    [
      'Portuguese',
      'Combinado.\n\nEm seg., 19 de out. de 2026 às 10:00, MUG <o@mug.invalid> escreveu:\n> Pode falar?',
    ],
    ['French', "D'accord.\n\nLe lun. 19 oct. 2026 à 10:00, MUG a écrit :\n> Pouvez-vous parler ?"],
    [
      'wrapped across two lines',
      'Sounds good.\n\nOn Mon, 19 Oct 2026 at 10:00, MUG Organiser <o@mug.invalid>\nwrote:\n> Would you speak?',
    ],
    [
      'Original Message',
      'Sounds good.\n\n-----Original Message-----\nFrom: MUG\nSent: Monday\nWould you speak?',
    ],
    [
      'Outlook header block',
      'Sounds good.\n\nFrom: MUG Organiser\nSent: Monday, 19 October 2026 10:00\nTo: Someone\nSubject: Speaking\n\nWould you speak?',
    ],
  ])('%s', (_name, body) => {
    expect(R(body)).toBe(
      _name === 'French' ? "D'accord." : _name === 'Portuguese' ? 'Combinado.' : 'Sounds good.',
    );
  });

  it('removes > quoted lines wherever they are, and keeps what follows an inline quote', () => {
    expect(stripQuotedHistory('Reply one.\n> quoted\nReply two.')).toBe('Reply one.\nReply two.');
  });

  it('keeps a message that merely mentions "wrote" or starts a line with On', () => {
    const body = 'On reflection I think it works.\nAs the docs say, someone wrote a good guide.';
    expect(R(body)).toBe(body);
  });
});

describe('signatures are stripped', () => {
  it('after a line that is exactly "-- "', () => {
    expect(stripSignature('Thanks!\n-- \nWendeline\nCTO, Example')).toBe('Thanks!');
    expect(R('Thanks!\n\n-- \nWendeline\nTel +351 210 000 000')).toBe('Thanks!');
  });
  it('but not a dash inside a sentence', () => {
    expect(stripSignature('A -- b\nand more')).toBe('A -- b\nand more');
  });
});

describe('phone numbers, postal addresses and email addresses', () => {
  it('phone numbers go, dates and short numbers stay', () => {
    expect(R('Call me on +351 912 345 678 or 210 000 000.')).toBe('Call me on [phone] or [phone].');
    expect(R('The talk is on 2026-12-12, room 12, 120 seats, 14:30.')).toBe(
      'The talk is on 2026-12-12, room 12, 120 seats, 14:30.',
    );
    expect(R('Deadline 12/12/2026 and 12.12.2026.')).toBe('Deadline 12/12/2026 and 12.12.2026.');
  });
  it('postal address lines go', () => {
    expect(R('See you there.\nRua das Flores 12, 3o\n1000-001 Lisboa\nThanks')).toBe(
      'See you there.\n[address]\n[address]\nThanks',
    );
    expect(R('Send to 221B Baker Street\nNW1 6XE')).toContain('[address]');
    // A street WORD without a digit is just a sentence.
    expect(R('The street is lovely in spring.')).toBe('The street is lovely in spring.');
  });
  it('email addresses are masked (a hygiene addition: no triage need for an address)', () => {
    expect(R('Write to ana@speakers.invalid please.')).toBe('Write to [email] please.');
  });
});

describe('the result is bounded, truncated from the END, with a marker', () => {
  it('under the limit: unchanged; over it: cut with a marker and never longer than the limit', () => {
    expect(R('short', 600)).toBe('short');
    const long = 'word '.repeat(2000);
    const out = R(long, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(out.startsWith('word word')).toBe(true);
  });
  it('is applied AFTER stripping, so a long quoted tail does not eat the budget', () => {
    const body =
      'The actual reply.\n\nOn Mon, 1 Jan 2026, X wrote:\n' + '> old text\n'.repeat(5000);
    expect(R(body, 600)).toBe('The actual reply.');
  });
  it('refuses a nonsensical limit', () => {
    expect(() => redactForTriage('x', 3)).toThrow(RangeError);
  });
});

describe('it is deterministic and total', () => {
  it('same input, same output; CRLF handled; empty stays empty', () => {
    const body = 'Hi\r\n\r\nOn Mon, 1 Jan 2026, X wrote:\r\n> hi';
    expect(R(body)).toBe(R(body));
    expect(R(body)).toBe('Hi');
    expect(R('')).toBe('');
    expect(R('   \n\n  ')).toBe('');
  });
});
