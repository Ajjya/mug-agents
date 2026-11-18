import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../src/config/config.module.js';
import {
  ConfigError,
  type ModelRef,
  formatModelRef,
  parseModelRef,
} from '../../src/config/env.schema.js';
import {
  GoldenNotVerifiedError,
  assertEvaluable,
  checkGolden,
  loadGolden,
} from '../../src/inbox/golden.js';
import { redactForTriage } from '../../src/inbox/redact.js';
import {
  type CaseResult,
  baselines,
  renderReport,
  scoreModel,
} from '../../src/inbox/triage.metrics.js';
import { fabricatedSpans, triageOutputLenientSchema } from '../../src/inbox/triage.schema.js';
import { triagePrompt } from '../../src/inbox/triage.js';
import { ProviderUnavailableError, StructuredOutputError } from '../../src/llm/errors.js';
import { buildProviders, buildStructuredCall } from '../../src/llm/llm.module.js';
import type { LlmCallRecord } from '../../src/llm/model.types.js';
import { AppLogger } from '../../src/logging/logger.module.js';

/**
 * npm run eval:triage -- --models <ref,...> [--dir <golden dir>] [--real]
 *
 * Triage over the golden set, one column per model, with escalation DISABLED: each model runs alone on a
 * one-rung ladder, so the numbers are that model's, not the ladder's. The prompt and the redaction are
 * production's. It refuses a golden set that is not fully verified: an unverified label is the model
 * grading itself. The default set is the committed fictional sample; --real uses corpus/private.
 */
const SAMPLE_DIR = 'corpus/sample/inbox-golden';
const REAL_DIR = 'corpus/private/inbox-golden';

function resultFrom(
  id: string,
  expected: CaseResult['expected'],
  text: string,
  calls: readonly LlmCallRecord[],
  output: CaseResult['output'],
): CaseResult {
  const spans = output
    ? output.mentions.dates.length +
      output.mentions.people.length +
      output.mentions.organisations.length
    : 0;
  return {
    id,
    expected,
    output,
    // Counted on the text the model was given, by substring search in code.
    fabricatedSpans: output ? fabricatedSpans(output.mentions, text).length : 0,
    mentionSpans: spans,
    attempts: calls.length,
    invalidAttempts: calls.filter((c) => c.outcome !== 'valid').length,
    latenciesMs: calls.filter((c) => c.latencyMs > 0).map((c) => c.latencyMs),
    constrained: calls.some((c) => c.constrained),
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      models: { type: 'string' },
      dir: { type: 'string' },
      real: { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  const config = loadConfig();
  const dir = values.dir ?? (values.real ? REAL_DIR : SAMPLE_DIR);

  const check = checkGolden(dir);
  try {
    assertEvaluable(check);
  } catch (err) {
    if (err instanceof GoldenNotVerifiedError) {
      console.error(err.message);
      for (const p of check.problems) console.error(`  - ${p}`);
      for (const f of check.perFile.filter((x) => x.unverified.length > 0)) {
        console.error(`  - ${f.name}: unverified ${f.unverified.join(', ')}`);
      }
      return 2;
    }
    throw err;
  }

  const refs: ModelRef[] = [];
  for (const raw of (values.models ?? config.TRIAGE_START_MODEL)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const ref = parseModelRef(raw);
    if (typeof ref === 'string') {
      console.error(`--models: ${ref}`);
      return 2;
    }
    refs.push(ref);
  }

  const golden = loadGolden(dir).map((g) => g.golden);
  const logger = new AppLogger(config);
  const providers = buildProviders(config);
  const scores = [];
  for (const ref of refs) {
    const label = formatModelRef(ref);
    const call = buildStructuredCall(config, providers, logger, [ref]); // a ladder of ONE: no escalation
    const cases: CaseResult[] = [];
    for (const g of golden) {
      const text = redactForTriage(g.body, config.TRIAGE_MAX_CHARS);
      try {
        const r = await call(triageOutputLenientSchema, triagePrompt(text, g.attachments), {
          node: 'triage-eval',
        });
        cases.push(resultFrom(g.id, g.expected, text, r.calls, r.value));
      } catch (err) {
        if (err instanceof StructuredOutputError) {
          cases.push(resultFrom(g.id, g.expected, text, err.attempts, undefined));
        } else if (err instanceof ProviderUnavailableError) {
          console.error(`PROVIDER FAILURE (not a model failure) on ${label}: ${err.message}`);
          return 3;
        } else throw err;
      }
    }
    scores.push({ model: label, score: scoreModel(cases) });
    console.log(
      `${label}: ${String(cases.filter((c) => c.output).length)}/${String(cases.length)} answered`,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const report = renderReport({
    date,
    dir,
    source: golden.every((g) => g.source === 'fictional') ? 'fictional' : 'real',
    seededBy: [...new Set(golden.map((g) => g.seededBy))],
    baselines: baselines(golden),
    scores,
  });
  // A report that exists is never overwritten (a re-run, or a reviewer's, must not replace the committed one):
  // the next free name is used instead (report-<date>-2.md, -3, ...).
  const base = fileURLToPath(
    new URL(`../../../evals/triage/report-${date}${values.real ? '-real' : ''}`, import.meta.url),
  );
  let out = values.out ?? `${base}.md`;
  for (let n = 2; !values.out && existsSync(out); n++) out = `${base}-${String(n)}.md`;

  fileURLToPath(
    new URL(
      `../../../evals/triage/report-${date}${values.real ? '-real' : ''}.md`,
      import.meta.url,
    ),
  );
  await writeFile(out, report);
  console.log(`\n${report}\nWritten to ${out}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(
      err instanceof ConfigError ? err.message : err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
  },
);
