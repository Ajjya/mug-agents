/**
 * Body normalisation, applied at INGESTION (new messages only). Marketing mail arrives padded with hundreds of
 * repetitions of &#8199; (figure space), &#847; (combining grapheme joiner) and &shy; (soft hyphen), and with
 * table structure collapsed into whitespace: about 8KB of body for 3 lines of content, which costs tokens on
 * every triage call. Normalising makes the text what a person would see, and bounds how much is stored.
 *
 * Deterministic and pure. It does NOT touch stored documents: `inbox repair-bodies` does that, on request.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
  zwnj: '‌',
  zwj: '‍',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
};

/** One pass only: `&amp;lt;` becomes `&lt;`, never `<`. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi,
    (whole, body: string) => {
      if (body.startsWith('#')) {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : '';
      }
      return NAMED[body.toLowerCase()] ?? whole;
    },
  );
}

/** Zero-width and invisible characters, the soft hyphen, and the combining grapheme joiner (U+034F). */
const isInvisible = (c: number): boolean =>
  c === 0xad ||
  c === 0x34f ||
  c === 0x61c ||
  c === 0x180e ||
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2060 && c <= 0x2064) ||
  (c >= 0x2066 && c <= 0x206f) ||
  c === 0xfeff;

/** Every space that is not a plain one (no-break, en/em/figure/thin, narrow no-break, ideographic ...). */
const isExoticSpace = (c: number): boolean =>
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000;

/** Code point by code point, so nothing depends on a regex over combining characters. */
function cleanCharacters(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (isInvisible(c)) continue;
    out += isExoticSpace(c) ? ' ' : ch;
  }
  return out;
}

export interface NormalisedBody {
  text: string;
  /** The body was longer than the cap and was cut. */
  truncated: boolean;
}

export function normaliseBody(raw: string, maxChars: number): NormalisedBody {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError('maxChars must be a positive integer');
  }
  const text = cleanCharacters(decodeEntities(raw))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ') // runs of spaces and tabs
    .replace(/ ?\n ?/g, '\n') // space hugging a line break
    .replace(/\n{3,}/g, '\n\n') // runs of blank lines
    .trim();
  return text.length > maxChars
    ? { text: text.slice(0, maxChars).trimEnd(), truncated: true }
    : { text, truncated: false };
}
