import { z } from 'zod';
import {
  type Mentions,
  MaterialsSchema,
  TRIAGE_CONFIDENCE,
  TRIAGE_DECISIONS,
  TRIAGE_INTENTS,
} from '../domain/inbox.schema.js';

/**
 * The LLM-facing triage schema (spec 7.1), separate from the domain schemas as always. The model emits
 * nothing that could be written straight into a domain record: no ids, no status values, no
 * normalised dates. `mentions` are verbatim spans, and code checks that each one really appears in
 * the text the model was given: a span that does not is a fabrication, refused and retried.
 */

const span = z.string().trim().min(1).max(200);
const spans = z.array(span).max(20);

const TriageOutputBaseSchema = z
  .object({
    intent: z.enum(TRIAGE_INTENTS),
    sentiment_decision: z.enum(TRIAGE_DECISIONS),
    mentions: z.object({ dates: spans, people: spans, organisations: spans }).strict(),
    materials: MaterialsSchema,
    asks: z.array(z.string().trim().min(1).max(200)).max(10),
    needs_human: z.boolean(),
    reason: z.string().trim().max(300),
    confidence: z.enum(TRIAGE_CONFIDENCE),
  })
  .strict();

export type TriageOutput = z.infer<typeof TriageOutputBaseSchema>;

/** Whitespace-collapsed, case-folded: "verbatim" tolerates a client's line wrapping, not invention. */
export const normaliseForSearch = (s: string): string =>
  s.replace(/\s+/g, ' ').trim().toLowerCase();

export const spanInText = (candidate: string, text: string): boolean =>
  normaliseForSearch(text).includes(normaliseForSearch(candidate));

/** The spans (as `kind[index]`) that do NOT appear in the text: the fabrication check, in code. */
export function fabricatedSpans(mentions: Mentions, text: string): string[] {
  const hay = normaliseForSearch(text);
  const out: string[] = [];
  for (const kind of ['dates', 'people', 'organisations'] as const) {
    mentions[kind].forEach((s, i) => {
      if (!hay.includes(normaliseForSearch(s))) out.push(`${kind}[${String(i)}]`);
    });
  }
  return out;
}

/**
 * Built per message, from the text the model was given. Issue messages never echo a span: they end up
 * in stored records and error messages, and must not carry text the model produced.
 */
export function triageOutputSchema(text: string) {
  return TriageOutputBaseSchema.superRefine((value, ctx) => {
    for (const where of fabricatedSpans(value.mentions, text)) {
      const [kind, idx] = where.replace(']', '').split('[') as [string, string];
      ctx.addIssue({
        code: 'custom',
        path: ['mentions', kind, Number(idx)],
        message: 'is not a verbatim span of the email text: copy spans exactly as written, or omit',
      });
    }
    if (value.needs_human && value.reason.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'is required when needs_human is true',
      });
    }
  });
}

// ---- materials against attachments: cross-checked in code, never by the model -------------------

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

const isImage = (a: AttachmentInfo): boolean => a.mimeType.startsWith('image/');
const isPresentation = (a: AttachmentInfo): boolean =>
  /presentation|powerpoint|keynote|opendocument\.presentation/.test(a.mimeType) ||
  a.mimeType === 'application/pdf';

/**
 * What the sender says they are providing, against what is actually attached. Flags disagreements for
 * a human; it never changes what the model said. An abstract or a bio may be in the text itself, and
 * slides may be a link, so those are noted, not accused.
 */
export function crossCheckMaterials(
  materials: TriageOutput['materials'],
  attachments: readonly AttachmentInfo[],
): string[] {
  const flags: string[] = [];
  const images = attachments.filter(isImage).length;
  const decks = attachments.filter(isPresentation).length;
  if (materials.photo && images === 0)
    flags.push('photo: the sender says a photo is provided but no image is attached');
  if (!materials.photo && images > 0)
    flags.push('photo: an image is attached but the message does not say a photo is provided');
  if (materials.slides && decks === 0)
    flags.push(
      'slides: the sender says slides are provided but no presentation or PDF is attached (a link, perhaps)',
    );
  if (!materials.slides && decks > 0)
    flags.push(
      'slides: a presentation or PDF is attached but the message does not say slides are provided',
    );
  return flags;
}
