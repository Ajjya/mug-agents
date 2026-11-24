import { z } from 'zod';
import { maskPersonalData } from './redact.js';

/**
 * Deterministic anonymisation for the golden set, in code (spec 8): real names, addresses and
 * organisations become stable FICTIONAL ones through a mapping file the organiser keeps out of git, so
 * the same person is the same pseudonym in every message and the set stays internally consistent.
 *
 * What it replaces: every key already in the mapping, every address found in the text, and whatever
 * the caller registers (the sender and recipients of a message, the speakers and organisations the
 * system knows, the people and organisations the model's proposed labels name). Names come from fixed
 * lists of obviously fictional ones (the same rule as the committed sample corpus). Anonymisation is
 * hygiene, not a guarantee: a set that came from real mail is stored only where git ignores it.
 */

export const PseudonymMapSchema = z
  .object({
    people: z.record(z.string(), z.string()),
    organisations: z.record(z.string(), z.string()),
    addresses: z.record(z.string(), z.string()),
  })
  .strict();
export type PseudonymMap = z.infer<typeof PseudonymMapSchema>;

export const emptyMap = (): PseudonymMap => ({ people: {}, organisations: {}, addresses: {} });

const FIRST = [
  'Wendeline',
  'Ignatius',
  'Zara',
  'Otto',
  'Mira',
  'Pip',
  'Barnaby',
  'Perpetua',
  'Cornelius',
  'Elowen',
  'Thaddeus',
  'Marigold',
  'Fitzwilliam',
  'Odalys',
  'Bartholomew',
  'Seraphina',
  'Quentin',
  'Rosalind',
];
const LAST = [
  'Gooseberry',
  'Fogwhistle',
  'Quillfeather',
  'Brambleworth',
  'Vantablack',
  'Lanternfield',
  'Thistlewick',
  'Marmaladeson',
  'Crumpetbottom',
  'Pennywhistle',
  'Dandelion',
  'Cobblestone',
  'Featherstonehaugh',
  'Higglebottom',
  'Periwinkle',
  'Snodgrass',
  'Wigglesworth',
  'Tumbleweed',
];
const ORGS = [
  'Cogwheel & Marmalade Ltd.',
  'Teapot Analytics',
  'Lantern Works',
  'Brassbutton & Daughters',
  'Gizmo Hollow Systems',
  'Pickle Quay Studios',
  'The Nimble Thimble Co.',
  'Turnip Row Software',
  'Hedgehog Logistics',
  'Marzipan Data',
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** A URL, up to whitespace or a closing bracket or quote. */
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
/** An address with its `@` percent-encoded (`name%40host.com`), which the plain pattern does not see. */
const PERCENT_EMAIL = /[\w.+-]+%40[\w-]+(?:\.[\w-]+)+/gi;
/** A long run of base64 or base64url characters: a candidate encoded blob. */
const TOKEN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
/** A long run of hex digits: an address spelled out byte by byte. */
const HEX = /\b(?:[0-9a-f]{2}){12,}\b/gi;
const EMAIL_ONCE = new RegExp(EMAIL.source);

/**
 * Query strings carry tokens, tracking ids and addresses (Google Calendar links put the recipient, encoded, in
 * `tok=` and `mark_sender_as_known=`). Nothing in a query is needed to see what a message is about, so it is
 * removed: scheme, host and path stay.
 */
export function stripUrlQueries(text: string): string {
  return text.replace(URL_RE, (url) => {
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
  });
}

/**
 * A candidate blob, as the pattern found it. `/` is part of standard base64 but also the separator in a URL path,
 * so it is tried whole first, then piece by piece (only the offending piece is replaced, the path stays).
 */
function scrubToken(token: string, replacement: () => string): string {
  if (tokenHidesAddress(token)) return replacement();
  if (!token.includes('/')) return token;
  return token
    .split('/')
    .map((piece) => (piece.length >= 16 && tokenHidesAddress(piece) ? replacement() : piece))
    .join('/');
}

/** Does this token, base64 or base64url decoded (up to three layers deep), contain an address? */
export function tokenHidesAddress(token: string, depth = 0): boolean {
  if (depth > 2) return false;
  const standard = token.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  let decoded: string;
  try {
    decoded = Buffer.from(standard, 'base64').toString('latin1');
  } catch {
    return false;
  }
  if (EMAIL_ONCE.test(decoded)) return true;
  // base64 of base64: look for a further blob inside what came out
  return (decoded.match(TOKEN) ?? []).some((inner) => tokenHidesAddress(inner, depth + 1));
}

export class Pseudonymiser {
  readonly map: PseudonymMap;

  constructor(map: PseudonymMap = emptyMap()) {
    this.map = structuredClone(map);
  }

  /** Next unused fictional name. Deterministic: the n-th new person is always the n-th combination. */
  private nextPerson(): string {
    const n = Object.keys(this.map.people).length;
    const first = FIRST[n % FIRST.length] ?? 'Person';
    const last = LAST[(n * 7 + Math.floor(n / FIRST.length)) % LAST.length] ?? 'Example';
    const round = Math.floor(n / (FIRST.length * LAST.length));
    return round === 0 ? `${first} ${last}` : `${first} ${last} ${String(round + 1)}`;
  }

  private nextOrganisation(): string {
    const n = Object.keys(this.map.organisations).length;
    const base = ORGS[n % ORGS.length] ?? 'Example Co.';
    return n < ORGS.length ? base : `${base} ${String(Math.floor(n / ORGS.length) + 1)}`;
  }

  private nextAddress(): string {
    return `person${String(Object.keys(this.map.addresses).length + 1)}@example.invalid`;
  }

  person(real: string): string {
    const key = real.trim();
    return (this.map.people[key] ||= this.nextPerson());
  }

  organisation(real: string): string {
    const key = real.trim();
    return (this.map.organisations[key] ||= this.nextOrganisation());
  }

  address(real: string): string {
    const key = real.trim().toLowerCase();
    return (this.map.addresses[key] ||= this.nextAddress());
  }

  /** Registers a name or organisation so the next `text()` call replaces it (and fixes its pseudonym). */
  learn(kind: 'person' | 'organisation', real: string | undefined): void {
    if (!real || real.trim().length < 2) return;
    if (kind === 'person') this.person(real);
    else this.organisation(real);
  }

  /**
   * Replaces everything known, longest first, case-insensitively; then masks phones and postal lines.
   * Each match becomes a placeholder first and the placeholders become pseudonyms at the end, so a
   * pseudonym can never be re-matched by a later (shorter) real name.
   */
  text(input: string): string {
    const slots: string[] = [];
    const hold = (fake: string): string => {
      slots.push(fake);
      return `\uE000${String(slots.length - 1)}\uE001`;
    };
    // Before anything else: the places an address hides that the plain pattern cannot see.
    let out = stripUrlQueries(input)
      .replace(PERCENT_EMAIL, (m) =>
        hold(this.address(decodeURIComponent(m.replace(/%40/gi, '@')))),
      )
      .replace(HEX, (h) =>
        EMAIL_ONCE.test(Buffer.from(h, 'hex').toString('latin1'))
          ? hold('[encoded-address-removed]')
          : h,
      )
      .replace(TOKEN, (t) => scrubToken(t, () => hold('[encoded-address-removed]')));
    out = out.replace(EMAIL, (m) => hold(this.address(m)));
    const pairs: [string, string][] = [
      ...Object.entries(this.map.people),
      ...Object.entries(this.map.organisations),
    ].filter(([real]) => real.length >= 2);
    for (const [real, fake] of pairs.sort((a, b) => b[0].length - a[0].length)) {
      out = out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(real)}(?![\\p{L}\\p{N}])`, 'giu'),
        () => hold(fake),
      );
    }
    out = maskPersonalData(out);
    return out.replace(/\uE000(\d+)\uE001/g, (_m, n: string) => slots[Number(n)] ?? '');
  }
}
