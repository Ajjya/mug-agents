import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  AttachmentSchema,
  MaterialsSchema,
  MentionsSchema,
  TRIAGE_DECISIONS,
  TRIAGE_INTENTS,
} from '../domain/inbox.schema.js';
import type { SpeakersRepository } from '../repositories/speakers.repository.js';
import type { OrganisationsRepository } from '../repositories/organisations.repository.js';
import { allPages } from '../agents/planner/plan-persistence.js';
import { PseudonymMapSchema, Pseudonymiser, emptyMap } from './anonymise.js';
import type {
  ContactsRepository,
  ExcludedThreadsRepository,
  InboundMessagesRepository,
} from './repositories.js';
import type { Triager } from './triage.js';

/**
 * The golden set (spec 8), built by CORRECTING, not by writing. `export-golden` turns stored, labelled
 * mail into one file per message: the anonymised body and the model's proposed labels, each field
 * marked "unverified". `check-golden` reports how many are still unverified and the eval refuses to
 * run on a set that is less than fully verified: an unverified label is the model grading itself.
 *
 * Honest about the bias: a set seeded from one model's output anchors on that model. Two things limit
 * it: every field is verified by a human before it counts, and the eval compares OTHER models and
 * configurations against it. Each file records which model seeded it.
 */

export const FIELD_STATUSES = ['unverified', 'verified'] as const;
const field = <T extends z.ZodType>(value: T) =>
  z.object({ value, status: z.enum(FIELD_STATUSES) }).strict();

/** The labels the eval scores. `mentions` and `asks` are not labelled: fabrication is checked in code. */
export const GOLDEN_FIELDS = ['intent', 'sentiment_decision', 'materials', 'needs_human'] as const;
export type GoldenField = (typeof GOLDEN_FIELDS)[number];

export const GoldenFileSchema = z
  .object({
    id: z.string().min(1),
    /** A real set lives in corpus/private (git-ignored); the committed sample is fictional. */
    source: z.enum(['real', 'fictional']),
    /** The model that proposed the labels, or `hand` for labels written by a person. */
    seededBy: z.string().min(1),
    attachments: z.array(AttachmentSchema),
    /** Anonymised, with quoted history and signature kept: the eval runs the real redaction on it. */
    body: z.string().min(1),
    expected: z
      .object({
        intent: field(z.enum(TRIAGE_INTENTS)),
        sentiment_decision: field(z.enum(TRIAGE_DECISIONS)),
        materials: field(MaterialsSchema),
        needs_human: field(z.boolean()),
      })
      .strict(),
    /** The model's proposed mentions, anonymised, for the human's eyes. Not scored. */
    proposedMentions: MentionsSchema.optional(),
  })
  .strict();
export type GoldenFile = z.infer<typeof GoldenFileSchema>;

// ---- check ---------------------------------------------------------------------------------------

export interface GoldenCheck {
  files: number;
  /** Fields (across all files) still marked "unverified". */
  unverified: number;
  perFile: { name: string; unverified: GoldenField[] }[];
  problems: string[];
  /** Messages per intent, and the majority class: what a constant answer would score. */
  intentCounts: Record<string, number>;
  majority: { intent: string; count: number; share: number } | null;
  ok: boolean;
}

export class GoldenNotVerifiedError extends Error {
  constructor(public readonly check: GoldenCheck) {
    super(
      check.files === 0
        ? 'The golden set is empty: nothing to evaluate.'
        : check.problems.length > 0
          ? `The golden set has ${String(check.problems.length)} invalid file(s): run "inbox check-golden <dir>".`
          : `${String(check.unverified)} golden label(s) are still "unverified": an unverified label is the model grading itself. Correct the files, mark each field "verified", and run "inbox check-golden <dir>".`,
    );
    this.name = 'GoldenNotVerifiedError';
  }
}

export function loadGolden(dir: string): { name: string; golden: GoldenFile }[] {
  return readGoldenDir(dir).loaded;
}

function readGoldenDir(dir: string): {
  loaded: { name: string; golden: GoldenFile }[];
  problems: string[];
} {
  const loaded: { name: string; golden: GoldenFile }[] = [];
  const problems: string[] = [];
  if (!existsSync(dir)) return { loaded, problems: [`${dir} does not exist`] };
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      problems.push(`${name}: not valid JSON`);
      continue;
    }
    const parsed = GoldenFileSchema.safeParse(raw);
    if (parsed.success) loaded.push({ name, golden: parsed.data });
    else {
      problems.push(
        `${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      );
    }
  }
  return { loaded, problems };
}

export function checkGolden(dir: string): GoldenCheck {
  const { loaded, problems } = readGoldenDir(dir);
  const perFile = loaded.map(({ name, golden }) => ({
    name,
    unverified: GOLDEN_FIELDS.filter((f) => golden.expected[f].status !== 'verified'),
  }));
  const unverified = perFile.reduce((n, f) => n + f.unverified.length, 0);
  const intentCounts: Record<string, number> = {};
  for (const { golden } of loaded) {
    const i = golden.expected.intent.value;
    intentCounts[i] = (intentCounts[i] ?? 0) + 1;
  }
  const top = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])[0];
  const ids = loaded.map((l) => l.golden.id);
  if (new Set(ids).size !== ids.length) problems.push('duplicate ids in the set');
  return {
    files: loaded.length,
    unverified,
    perFile,
    problems,
    intentCounts,
    majority: top ? { intent: top[0], count: top[1], share: top[1] / loaded.length } : null,
    ok: loaded.length > 0 && problems.length === 0 && unverified === 0,
  };
}

/** The eval's gate. */
export function assertEvaluable(check: GoldenCheck): void {
  if (!check.ok) throw new GoldenNotVerifiedError(check);
}

// ---- export --------------------------------------------------------------------------------------

export const ExportMapSchema = PseudonymMapSchema.extend({
  /** gmailId -> golden file id, so a re-run never exports a message twice (or overwrites a correction). */
  exported: z.record(z.string(), z.string()),
});
export type ExportMap = z.infer<typeof ExportMapSchema>;

export class UntrackedPathRequiredError extends Error {
  constructor(public readonly path: string) {
    super(
      `${path} is inside the repository and is not git-ignored. Anonymised real mail must live where git ignores it (corpus/private/ is), or outside the repository.`,
    );
    this.name = 'UntrackedPathRequiredError';
  }
}

/** A path inside the repository must be git-ignored; a path outside it is fine. */
export function assertNotTracked(path: string, repoRoot = process.cwd()): void {
  const abs = resolve(path);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return; // outside the repository
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: repoRoot });
  if (r.status !== 0) throw new UntrackedPathRequiredError(path);
}

export interface ExportDeps {
  inbound: InboundMessagesRepository;
  speakers: SpeakersRepository;
  organisations: OrganisationsRepository;
  contacts: ContactsRepository;
  /** Excluded threads are not exported: nothing further from them is read, triaged or copied. */
  excluded: ExcludedThreadsRepository;
  triager: Triager;
}

export interface ExportOptions {
  outDir: string;
  /** The pseudonym mapping, kept out of git. Default: `<outDir>/.pseudonyms.json`. */
  mappingPath?: string;
  limit?: number;
  repoRoot?: string;
}

export interface ExportReport {
  written: string[];
  skippedExisting: number;
  skippedAlreadyExported: number;
  skippedExcluded: number;
}

const extOf = (filename: string): string => /\.[A-Za-z0-9]{1,8}$/.exec(filename)?.[0] ?? '';

export async function exportGolden(
  deps: ExportDeps,
  options: ExportOptions,
): Promise<ExportReport> {
  const mappingPath = options.mappingPath ?? join(options.outDir, '.pseudonyms.json');
  assertNotTracked(options.outDir, options.repoRoot);
  assertNotTracked(mappingPath, options.repoRoot);
  mkdirSync(options.outDir, { recursive: true });
  mkdirSync(dirname(mappingPath), { recursive: true });

  const stored: ExportMap = existsSync(mappingPath)
    ? ExportMapSchema.parse(JSON.parse(readFileSync(mappingPath, 'utf8')))
    : { ...emptyMap(), exported: {} };
  const pseud = new Pseudonymiser({
    people: stored.people,
    organisations: stored.organisations,
    addresses: stored.addresses,
  });

  // Everyone the system knows about is registered first, so a name that appears only in a body is still replaced.
  for (const s of await allPages((after) =>
    deps.speakers.findMany({ limit: 200, ...(after ? { after } : {}) }),
  )) {
    pseud.learn('person', s.name);
    if (s.preferredName) pseud.learn('person', s.preferredName);
    for (const e of s.emails) pseud.address(e);
  }
  for (const o of await allPages((after) =>
    deps.organisations.findMany({ limit: 200, ...(after ? { after } : {}) }),
  )) {
    pseud.learn('organisation', o.name);
  }
  for (const c of await allPages((after) =>
    deps.contacts.findMany({ limit: 200, ...(after ? { after } : {}) }),
  )) {
    pseud.learn('person', c.name);
    pseud.address(c.address);
  }

  const report: ExportReport = {
    written: [],
    skippedExisting: 0,
    skippedAlreadyExported: 0,
    skippedExcluded: 0,
  };
  let counter = Object.keys(stored.exported).length;
  for (const m of await deps.inbound.findRecent(options.limit ?? 500)) {
    if (stored.exported[m.gmailId]) {
      report.skippedAlreadyExported++;
      continue;
    }
    if ((await deps.excluded.findByThreadId(m.threadId))?.status === 'excluded') {
      report.skippedExcluded++;
      continue;
    }
    const raw = await deps.inbound.getRawBody(m._id);
    if (raw === null) continue;
    pseud.learn('person', m.from.name);
    pseud.address(m.from.address);
    for (const t of m.to) {
      pseud.learn('person', t.name);
      pseud.address(t.address);
    }
    // The model's proposal: the stored triage, or a fresh run on the stored (redacted) text.
    let summary = m.triage;
    let seededBy = summary?.model ?? 'none (triage unavailable)';
    if (!summary) {
      const out = await deps.triager.run(m.bodyRedacted, m.attachments);
      if (out.ok) {
        summary = out.summary;
        seededBy = out.summary.model;
      }
    }
    for (const p of summary?.mentions.people ?? []) pseud.learn('person', p);
    for (const o of summary?.mentions.organisations ?? []) pseud.learn('organisation', o);

    const id = `g${String(++counter).padStart(3, '0')}`;
    const file: GoldenFile = {
      id,
      source: 'real',
      seededBy,
      attachments: m.attachments.map((a, i) => ({
        filename: `attachment-${String(i + 1)}${extOf(a.filename)}`,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
      body: pseud.text(raw) || '(empty)',
      expected: {
        intent: { value: summary?.intent ?? 'other', status: 'unverified' },
        sentiment_decision: {
          value: summary?.sentiment_decision ?? 'unclear',
          status: 'unverified',
        },
        materials: {
          value: summary?.materials ?? { abstract: false, bio: false, photo: false, slides: false },
          status: 'unverified',
        },
        // With no proposal at all, the safe proposal is "a human should look".
        needs_human: { value: summary?.needs_human ?? true, status: 'unverified' },
      },
      ...(summary
        ? {
            proposedMentions: {
              dates: summary.mentions.dates.map((x) => pseud.text(x)),
              people: summary.mentions.people.map((x) => pseud.text(x)),
              organisations: summary.mentions.organisations.map((x) => pseud.text(x)),
            },
          }
        : {}),
    };
    try {
      // 'wx': a file that exists is a file a human may have corrected. Never overwritten.
      writeFileSync(join(options.outDir, `${id}.json`), `${JSON.stringify(file, null, 2)}\n`, {
        flag: 'wx',
      });
      report.written.push(id);
      stored.exported[m.gmailId] = id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      report.skippedExisting++;
      counter--;
    }
  }
  writeFileSync(
    mappingPath,
    `${JSON.stringify({ ...pseud.map, exported: stored.exported } satisfies ExportMap, null, 2)}\n`,
    { mode: 0o600 },
  );
  return report;
}
