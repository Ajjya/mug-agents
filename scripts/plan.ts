import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { EventNotFoundError } from '../src/agents/planner/plan-persistence.js';
import {
  InvalidBriefError,
  PlanRunInterruptedError,
  PlannerService,
  type PlanStartResult,
} from '../src/agents/planner/planner.service.js';
import { PastEventDateError } from '../src/agents/planner/timeline.js';
import { formatReview } from '../src/approvals/format.js';
import { loadConfig } from '../src/config/config.module.js';
import { ConfigError, type AppConfig } from '../src/config/env.schema.js';
import { ProviderUnavailableError } from '../src/llm/errors.js';
import { summariseCalls } from '../src/llm/usage.js';
import { AppLogger } from '../src/logging/logger.module.js';

const USAGE = 'Usage: npm run plan -- --brief <file.json> [--start-at <ladder index>] [--replan]';

function print(result: PlanStartResult, config: AppConfig): void {
  if (result.status === 'already_planned') {
    console.log(
      `\nEvent ${result.event._id} ("${result.event.title}") is already planned: ${String(result.existingTasks)} agent-created tasks exist.\n` +
        'No model was called and nothing was written. Use --replan to generate again (only new task titles are added).',
    );
    return;
  }
  const out: string[] = [];
  out.push(
    `\nEvent ${result.event._id}: ${result.event.title}  [${result.event.phase}]  ${result.event.date ?? 'no date'}`,
  );
  out.push(`Thread ${result.threadId}`);
  if (result.status === 'awaiting_approval') {
    if (result.review) out.push('', formatReview(result.review));
    out.push(
      '',
      result.alreadyWaiting
        ? 'A plan for this event is already waiting for a decision (no model was called).'
        : 'Nothing has been persisted yet. The plan is waiting for a decision.',
      result.requestId
        ? `  npm run approvals -- show ${result.requestId}\n  npm run approvals -- approve ${result.requestId}\n  npm run approvals -- reject ${result.requestId} --reason "..."`
        : '  npm run approvals -- list',
    );
  } else {
    out.push(
      result.outcome === 'rejected'
        ? 'Plan rejected: nothing persisted.'
        : `Plan persisted: ${String(result.created)} tasks created, ${String(result.skipped)} already existed.`,
    );
  }
  const usage = summariseCalls(result.calls, config.LLM_PRICES);
  if (usage.calls > 0) {
    out.push(
      `\nModel calls: ${String(usage.calls)} (${result.calls.map((c) => `${c.node}#${String(c.attempt)} ${c.model} ${c.outcome}`).join('; ')})`,
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
    const result = await service.startPlan(input, {
      ...(startAt === undefined ? {} : { startAt }),
      ...(values.replan ? { replan: true } : {}),
    });
    print(result, config);
    return 0;
  } catch (err) {
    if (
      err instanceof PastEventDateError ||
      err instanceof InvalidBriefError ||
      err instanceof EventNotFoundError
    ) {
      console.error(`\nRejected before any model call: ${err.message}`);
      return 2;
    }
    // A provider outage and a model failure are reported apart; the run is resumable either way.
    if (err instanceof PlanRunInterruptedError) {
      const provider = err.cause instanceof ProviderUnavailableError;
      console.error(
        `\n${provider ? 'PROVIDER FAILURE (not a model failure)' : 'MODEL FAILURE'}: ${err.cause.message}\n` +
          `Nothing was persisted. The thread kept its progress.\nResume: npm run approvals -- resume ${err.threadId}`,
      );
      return provider ? 3 : 4;
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
