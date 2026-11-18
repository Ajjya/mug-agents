/**
 * Deterministic redaction, in code, before a body reaches a prompt (spec 2). Hygiene, not a guarantee:
 * the sensitive part of a message is often its substance, which cannot be stripped and still
 * classified. The guarantee is the mailbox scope (spec 1): the organiser chooses what the system sees.
 *
 * What is removed, in this order:
 *  1. quoted history: everything from the first standard reply marker down ("On <date>, <name> wrote:",
 *     "-----Original Message-----", an Outlook From:/Sent: header block, the Portuguese, French and
 *     Spanish equivalents), plus any line starting with `>`;
 *  2. the signature: everything after a line that is exactly `-- `;
 *  3. email addresses, phone numbers and postal addresses (heuristics, listed below);
 *  4. the result is bounded to `maxChars`, cut from the END with a marker.
 *
 * Heuristics are documented, not clever: a phone number is 9 to 15 digits that is not date-shaped; a
 * postal line has a postcode (Portuguese NNNN-NNN, UK) or starts with a street word and has a digit.
 * Whatever they miss is still bounded by the scope; whatever they over-strip only costs a little context.
 */

export const TRUNCATION_MARKER = '\n[... truncated]';

/** A dashed line naming the original or forwarded message, in the languages mail here arrives in. */
const REPLY_MARKERS: readonly RegExp[] = [
  /^-{2,}\s*(Original Message|Mensagem original|Mensaje original|Message d'origine|Original-Nachricht|Messaggio originale|Oorspronkelijk bericht)\s*-{2,}\s*$/i,
  /^-{2,}\s*(Forwarded message|Mensagem encaminhada|Mensaje reenviado|Message transf[eé]r[eé]|Weitergeleitete Nachricht|Messaggio inoltrato)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/, // the rule above an Outlook header block
];

const VERBS = 'wrote|escreveu|a écrit|escribió|schrieb|schreef|ha scritto';
const OPENERS = 'On|Em|No dia|Le|El|Am|Op|Il';
/**
 * "On ... wrote:" and its translations, on one line. The colon is REQUIRED: without it an ordinary
 * sentence that happens to end in "escreveu" would cut a message in half.
 * "No dia ... escreveu:" is, I believe, what European-Portuguese Gmail writes; unverified against a real mailbox.
 */
const WROTE_LINE = new RegExp(`^(${OPENERS})\\b.{3,300}\\b(${VERBS})\\s*:\\s*$`, 'i');
/** German and Dutch put the verb BEFORE the name: "Am 19.10. um 10:00 schrieb Ana <a@x>:". */
const WROTE_VERB_FIRST = /^(Am|Op)\b.{3,200}\b(schrieb|schreef)\b.{1,200}:\s*$/i;
/** The same, when the client wrapped it so that only the second line ends in "wrote:". */
const WROTE_TAIL = new RegExp(`^.{0,200}\\b(${VERBS})\\s*:\\s*$`, 'i');
const OPENER_START = new RegExp(`^(${OPENERS})\\b`, 'i');
/** An Outlook-style header block: a From-line followed by a Sent/To/Subject line (bold markers ignored). */
const HEADER_BLOCK = /^(From|De|Von|Da|Van):\s.+$/i;
const HEADER_FOLLOW =
  /^(Sent|Date|Enviado|Data|To|Para|Subject|Assunto|An|Betreff|Gesendet|Datum|Inviato|Oggetto|Aan|Onderwerp|Verzonden):\s/i;

/** Non-breaking spaces and markdown emphasis are noise for matching a marker. */
const plain = (line: string): string =>
  line
    .replace(/\u00a0/g, ' ')
    .replace(/[*_]{1,3}/g, '')
    .trim();

export function stripQuotedHistory(text: string): string {
  const lines = text.split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = plain(lines[i] ?? '');
    const next = plain(lines[i + 1] ?? '');
    const marker =
      REPLY_MARKERS.some((re) => re.test(line)) ||
      WROTE_LINE.test(line) ||
      WROTE_VERB_FIRST.test(line) ||
      (OPENER_START.test(line) && WROTE_TAIL.test(next)) ||
      (HEADER_BLOCK.test(line) && HEADER_FOLLOW.test(next));
    if (marker) {
      cut = i;
      break;
    }
  }
  return lines
    .slice(0, cut)
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n');
}

/** Everything after a line that is exactly `-- ` (the standard signature separator). */
export function stripSignature(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l === '-- ' || l === '--');
  return at === -1 ? text : lines.slice(0, at).join('\n');
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+|00)?\d[\d\s().-]{7,}\d/g;
const DATE_SHAPED = /^(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})$/;

function isPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15 && !DATE_SHAPED.test(candidate.trim());
}

const POSTCODE = /\b\d{4}-\d{3}\b|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
const STREET_WORD =
  /^\s*(?:\d+[,\s]+)?(?:Rua|Av\.?|Avenida|Travessa|Pra[cç]a|Largo|Estrada|Street|St\.|Road|Rd\.|Avenue|Ave\.|Lane|Ln\.|Boulevard|Blvd\.?|Calle|Rue)\b/i;

function redactLine(line: string): string {
  if (POSTCODE.test(line) || (STREET_WORD.test(line) && /\d/.test(line))) return '[address]';
  return line.replace(EMAIL, '[email]').replace(PHONE, (m) => (isPhone(m) ? '[phone]' : m));
}

/**
 * Masks emails, phone numbers and postal-address lines WITHOUT stripping quoted history or the
 * signature. The golden set stores bodies this way, so the eval still exercises the real redaction.
 */
export function maskPersonalData(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(redactLine).join('\n');
}

export function redactForTriage(body: string, maxChars: number): string {
  if (!Number.isInteger(maxChars) || maxChars <= TRUNCATION_MARKER.length) {
    throw new RangeError('maxChars must be an integer larger than the truncation marker');
  }
  let text = body.replace(/\r\n?/g, '\n');
  text = stripQuotedHistory(text);
  text = stripSignature(text);
  text = text.split('\n').map(redactLine).join('\n');
  text = text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length <= maxChars
    ? text
    : text.slice(0, maxChars - TRUNCATION_MARKER.length).trimEnd() + TRUNCATION_MARKER;
}
