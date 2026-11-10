import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LangGraphPlanner } from '../src/agents/planner/planner.graph.js';
import { PlannerService } from '../src/agents/planner/planner.service.js';
import { PastEventDateError } from '../src/agents/planner/timeline.js';
import { loadConfig } from '../src/config/config.module.js';
import {
  ConfigError,
  type AppConfig,
  type ModelRef,
  formatModelRef,
  parseModelRef,
} from '../src/config/env.schema.js';
import { ProviderUnavailableError, StructuredOutputError } from '../src/llm/errors.js';
import {
  buildProviders,
  buildStructuredCall,
  type ProviderRegistry,
} from '../src/llm/llm.module.js';
import type { LlmCallRecord } from '../src/llm/model.types.js';
import type { StructuredCall } from '../src/llm/structured.js';
import { AppLogger } from '../src/logging/logger.module.js';
import {
  InMemoryEventsRepository,
  InMemoryTasksRepository,
} from '../test/support/in-memory.repositories.js';
import { assertDraft, firstFailure } from './assertions.js';
import { type CaseOutcome, renderReport } from './report.js';

interface EvalCase {
  id: string;
  description: string;
  expect: 'plan' | 'reject';
  /** Relative to today, so the case never goes stale. */
  daysFromNow: number;
  brief: Record<string, unknown>;
}

const root = new URL('../../evals/', import.meta.url);

async function loadCases(): Promise<EvalCase[]> {
  const dir = new URL('cases/', root);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), 'utf8')) as EvalCase),
  );
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

async function runCase(
  c: EvalCase,
  ref: ModelRef,
  config: AppConfig,
  providers: ProviderRegistry,
  logger: AppLogger,
  now: Date,
): Promise<CaseOutcome> {
  const model = formatModelRef(ref);
  const calls: LlmCallRecord[] = [];
  // Pinned rung: a ladder of one, so a validation failure never climbs.
  const base = buildStructuredCall(config, providers, logger, [ref]);
  const tracked: StructuredCall = async (schema, prompt, options) => {
    try {
      const r = await base(schema, prompt, options);
      calls.push(...r.calls);
      return r;
    } catch (err) {
      if (err instanceof StructuredOutputError || err instanceof ProviderUnavailableError) {
        calls.push(...err.attempts);
      }
      throw err;
    }
  };
  const graph = new LangGraphPlanner(tracked);
  const events = new InMemoryEventsRepository();
  const tasks = new InMemoryTasksRepository();
  const service = new PlannerService(graph, events, tasks);
  const date = isoDay(new Date(now.getTime() + c.daysFromNow * 86_400_000));
  const raw = { ...c.brief, date };
  const outcome = (status: CaseOutcome['status'], failure?: string): CaseOutcome => ({
    caseId: c.id,
    model,
    status,
    ...(failure === undefined ? {} : { failure }),
    calls,
  });

  if (c.expect === 'reject') {
    try {
      await service.plan(raw, { now });
      return outcome('fail', 'expected the past date to be rejected, but a plan was produced');
    } catch (err) {
      if (!(err instanceof PastEventDateError)) {
        return outcome(
          'fail',
          `expected PastEventDateError, got ${err instanceof Error ? err.name : 'unknown'}`,
        );
      }
      return calls.length === 0
        ? outcome('pass')
        : outcome('fail', 'a model was called for a rejected brief');
    }
  }

  try {
    const brief = service.parseBrief(raw);
    const draft = await graph.run(brief, { now });
    const results = assertDraft(draft);

    // Re-running on the same plan must add nothing (spec: idempotency).
    const first = await service.persist(draft);
    const before = await tasks.count();
    const second = await service.persist(draft);
    const after = await tasks.count();
    results.push({
      name: 'rerun-creates-no-additional-tasks',
      pass: second.created.length === 0 && after === before && first.created.length === before,
      detail: `first run created ${String(first.created.length)}, second ${String(second.created.length)}, total ${String(before)} -> ${String(after)}`,
    });

    const failed = firstFailure(results);
    return failed
      ? outcome('fail', `${failed.name}${failed.detail ? `: ${failed.detail}` : ''}`)
      : outcome('pass');
  } catch (err) {
    // Provider problems and model problems are reported apart, never mixed.
    if (err instanceof ProviderUnavailableError) return outcome('provider_failure', err.message);
    if (err instanceof StructuredOutputError) {
      return outcome('fail', `structured-output (${err.node}): ${err.issues[0] ?? err.reason}`);
    }
    return outcome('fail', `error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { models: { type: 'string' } } });
  if (!values.models) {
    console.error(
      'Usage: npm run eval -- --models ollama:gpt-oss:20b,ollama:gemma4:31b,ollama:mistral-large-4',
    );
    return 2;
  }
  const refs: ModelRef[] = [];
  for (const raw of values.models
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const parsed = parseModelRef(raw);
    if (typeof parsed === 'string') {
      console.error(`--models: ${parsed}`);
      return 2;
    }
    refs.push(parsed);
  }
  if (refs.length === 0) {
    console.error('--models: at least one model ref is required');
    return 2;
  }

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  if (config.OLLAMA_API_KEY === undefined) {
    console.error(
      'OLLAMA_API_KEY is not set. Put it in .env (create one at https://ollama.com/settings/keys).',
    );
    return 1;
  }

  const logger = new AppLogger(config);
  const providers = buildProviders(config); // one shared semaphore for every case x model
  const cases = await loadCases();
  const now = new Date();
  const total = cases.length * refs.length;
  console.log(
    `Running ${String(cases.length)} cases x ${String(refs.length)} models = ${String(total)} runs, at most ${String(config.OLLAMA_MAX_CONCURRENCY)} requests in flight. This takes minutes.`,
  );

  let done = 0;
  const outcomes = await Promise.all(
    cases.flatMap((c) =>
      refs.map(async (ref) => {
        const started = Date.now();
        const o = await runCase(c, ref, config, providers, logger, now);
        done++;
        console.log(
          `[${String(done)}/${String(total)}] ${c.id} ${formatModelRef(ref)} ${o.status.toUpperCase()} (${((Date.now() - started) / 1000).toFixed(1)}s)${o.failure ? ` - ${o.failure}` : ''}`,
        );
        return o;
      }),
    ),
  );

  const date = isoDay(now);
  let path = fileURLToPath(new URL(`report-${date}.md`, root));
  for (let n = 2; existsSync(path); n++)
    path = fileURLToPath(new URL(`report-${date}-${String(n)}.md`, root));
  await writeFile(
    path,
    renderReport({
      date,
      caseIds: cases.map((c) => c.id),
      models: refs.map((r) => ({
        model: formatModelRef(r),
        constrained: providers[r.provider].constrainsOutput,
      })),
      outcomes,
      prices: config.LLM_PRICES,
      maxConcurrency: config.OLLAMA_MAX_CONCURRENCY,
    }),
  );
  console.log(`\nReport written to ${path}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
