import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import {
  EventNotFoundError,
  InvalidBriefError,
  PlannerService,
  type PlanResult,
} from '../src/agents/planner/planner.service.js';
import { PastEventDateError } from '../src/agents/planner/timeline.js';
import { loadConfig } from '../src/config/config.module.js';
import { ConfigError, type AppConfig } from '../src/config/env.schema.js';
import { ProviderUnavailableError, StructuredOutputError } from '../src/llm/errors.js';
import { summariseCalls } from '../src/llm/usage.js';
import { AppLogger } from '../src/logging/logger.module.js';

const USAGE = 'Usage: npm run plan -- --brief <file.json> [--start-at <ladder index>] [--replan]';

function print(result: PlanResult, config: AppConfig): void {
  const { event, milestones, timeline, checklist } = result;
  const out: string[] = [];
  out.push(`\nEvent ${event._id}: ${event.title}  [${event.phase}]  ${event.date ?? 'no date'}`);
  out.push(result.eventCreated ? '  (new event)' : '  (existing event updated)');
  out.push('\nTIMELINE');
  for (const m of milestones) {
    const goal = timeline.milestones.find((t) => t.key === m.key);
    const flag = m.clamped ? '  [past: moved to today]' : '';
    out.push(`  ${m.key.padEnd(7)} ${m.dateIso.slice(0, 10)}  ${m.label}${flag}`);
    if (goal) {
      out.push(`          goal: ${goal.goal}`);
      for (const w of goal.work) out.push(`          - ${w}`);
    }
  }
  out.push('\nCHECKLIST');
  for (const m of milestones) {
    const items = checklist.tasks.filter((t) => t.milestone === m.key);
    if (items.length === 0) continue;
    out.push(`  ${m.key} (${m.dateIso.slice(0, 10)})`);
    for (const t of items) out.push(`    [ ] ${t.title}  (${t.owner})`);
  }
  out.push(
    `\nTasks created: ${String(result.created.length)}, already existed: ${String(result.skipped)}`,
  );
  const usage = summariseCalls(result.calls, config.LLM_PRICES);
  if (usage.calls > 0) {
    out.push(
      `Model calls: ${String(usage.calls)} (${result.calls.map((c) => `${c.node}#${String(c.attempt)} ${c.model} ${c.outcome}`).join('; ')})`,
      `Tokens in/out: ${String(usage.tokensIn)}/${String(usage.tokensOut)}, model time: ${String(usage.latencyMs)} ms` +
        (usage.cost === undefined ? '' : `, est. cost: $${usage.cost.toFixed(5)}`),
    );
  }
  console.log(out.join('\n'));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      brief: { type: 'string' },
      'start-at': { type: 'string' },
      replan: { type: 'boolean' },
    },
  });
  if (!values.brief) {
    console.error(USAGE);
    return 2;
  }
  let input: unknown;
  try {
    input = JSON.parse(await readFile(values.brief, 'utf8'));
  } catch (err) {
    console.error(
      `Cannot read brief ${values.brief}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  const logger = new AppLogger(config);
  const app = await NestFactory.createApplicationContext(AppModule.register(config, logger), {
    logger,
    abortOnError: false,
  });
  try {
    const service = app.get(PlannerService, { strict: false });
    const startAt = values['start-at'] === undefined ? undefined : Number(values['start-at']);
    const outcome = await service.ensurePlanned(input, {
      ...(startAt === undefined ? {} : { startAt }),
      ...(values.replan ? { replan: true } : {}),
    });
    if (outcome.status === 'already_planned') {
      console.log(
        `\nEvent ${outcome.event._id} ("${outcome.event.title}") is already planned: ${String(outcome.existingTasks)} agent-created tasks exist.\nNo model was called and nothing was written. Use --replan to generate again (only new task titles are added; nothing is deleted).`,
      );
      return 0;
    }
    print(outcome, config);
    return 0;
  } catch (err) {
    // A provider outage and a model failure must never be confused, so they are reported apart.
    if (
      err instanceof PastEventDateError ||
      err instanceof InvalidBriefError ||
      err instanceof EventNotFoundError
    ) {
      console.error(`\nRejected before any model call: ${err.message}`);
      return 2;
    }
    if (err instanceof ProviderUnavailableError) {
      console.error(
        `\nPROVIDER FAILURE (not a model failure): ${err.message}\nNothing was written.`,
      );
      return 3;
    }
    if (err instanceof StructuredOutputError) {
      console.error(
        `\nMODEL FAILURE: ${err.message}\nNothing was written. Attempts: ${err.attempts.map((a) => `${a.model}:${a.outcome}`).join(', ')}`,
      );
      return 4;
    }
    throw err;
  } finally {
    await app.close();
  }
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
