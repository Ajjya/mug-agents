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
    let out = input.replace(EMAIL, (m) => hold(this.address(m)));
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
