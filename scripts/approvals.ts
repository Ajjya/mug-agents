import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import type { DecisionValue } from '../src/approvals/approval.schema.js';
import {
  ApprovalConflictError,
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ApprovalOrphanError,
  ApprovalsService,
} from '../src/approvals/approvals.service.js';
import { formatListing, formatRequest, formatThreadOutcome } from '../src/approvals/format.js';
import { InvalidEditError, PlanReviewPayloadSchema } from '../src/approvals/plan-review.payload.js';
import { loadConfig } from '../src/config/config.module.js';
import { ConfigError, type AppConfig } from '../src/config/env.schema.js';
import { ProviderUnavailableError, StructuredOutputError } from '../src/llm/errors.js';
import { AppLogger } from '../src/logging/logger.module.js';

const USAGE = `Usage: npm run approvals -- <command> [options]

  list                                     pending requests (orphans flagged) and resumable threads
  show <id> [--json]                       the plan under review (--json: the payload, for editing)
  approve <id> [--by <name>]               resume with approval
  edit <id> --file <edited.json> [--by <name>]
                                           validate the file against the payload schema, then resume
  reject <id> --reason "..." [--by <name>] reason is mandatory
  resume <threadId>                        continue a stopped thread (failed node, orphan, or an
                                           undelivered decision)

Decisions are recorded as the name given by --by, else APPROVER_NAME, else your OS user name.`;

async function run(service: ApprovalsService, config: AppConfig, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      by: { type: 'string' },
      file: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const [command, target] = positionals;
  const decidedBy = values.by ?? config.APPROVER_NAME ?? userInfo().username;

  switch (command) {
    case 'list': {
      console.log(formatListing(await service.list()));
      return 0;
    }
    case 'show': {
      if (!target) break;
      const { request, thread, decision } = await service.show(target);
      console.log(
        values.json
          ? JSON.stringify(request.payload, null, 2)
          : formatRequest(request, thread, decision),
      );
      return 0;
    }
    case 'approve':
    case 'edit':
    case 'reject': {
      if (!target) break;
      let value: DecisionValue;
      if (command === 'approve') value = { decision: 'approve' };
      else if (command === 'reject') {
        if (!values.reason?.trim()) {
          console.error('reject needs --reason "..." (a reason is mandatory)');
          return 2;
        }
        value = { decision: 'reject', reason: values.reason };
      } else {
        if (!values.file) {
          console.error('edit needs --file <edited.json>');
          return 2;
        }
        const raw: unknown = JSON.parse(await readFile(values.file, 'utf8'));
        const editedPayload = PlanReviewPayloadSchema.parse(raw); // validated before anything is resumed
        value = { decision: 'edit', editedPayload };
      }
      const result = await service.decide(target, value, decidedBy);
      console.log(
        `Recorded ${result.decision.decision} by ${decidedBy} for request ${result.request._id}.`,
      );
      console.log(formatThreadOutcome(result.thread));
      return 0;
    }
    case 'resume': {
      if (!target) break;
      const r = await service.resumeThread(target);
      switch (r.status) {
        case 'resumed':
          console.log(`Resumed ${target}. ${formatThreadOutcome(r.thread)}`);
          if (r.thread.status === 'awaiting_decision')
            console.log('Decide with: npm run approvals -- list');
          return 0;
        case 'awaiting_decision':
          console.log(
            `Thread ${target} is waiting for a decision${r.requestId ? ` (request ${r.requestId})` : ''}: use approve, edit or reject.`,
          );
          return 0;
        case 'already_completed':
          console.log(`Thread ${target} already finished. ${formatThreadOutcome(r.thread)}`);
          return 0;
        case 'no_checkpoint':
          console.log(
            `Thread ${target} has no checkpoint, so there is nothing to resume.${r.expired > 0 ? ` Marked ${String(r.expired)} orphaned request(s) expired (nothing is deleted).` : ''}`,
          );
          return 0;
      }
    }
  }
  console.error(USAGE);
  return 2;
}

async function main(): Promise<number> {
  if (process.argv.length <= 2 || ['-h', '--help', 'help'].includes(process.argv[2] ?? '')) {
    console.log(USAGE);
    return process.argv.length <= 2 ? 2 : 0;
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
    return await run(app.get(ApprovalsService, { strict: false }), config, process.argv.slice(2));
  } catch (err) {
    if (
      err instanceof ApprovalNotFoundError ||
      err instanceof ApprovalNotPendingError ||
      err instanceof ApprovalConflictError ||
      err instanceof InvalidEditError
    ) {
      console.error(err.message);
      return 2;
    }
    if (err instanceof ApprovalOrphanError) {
      console.error(err.message);
      return 3;
    }
    if (err instanceof z.ZodError) {
      console.error(`Invalid input:\n${z.prettifyError(err)}`);
      return 2;
    }
    // The thread kept its progress either way; a provider outage and a model failure are never mixed.
    if (err instanceof ProviderUnavailableError) {
      console.error(
        `PROVIDER FAILURE (not a model failure): ${err.message}\nThe thread is resumable: npm run approvals -- list`,
      );
      return 3;
    }
    if (err instanceof StructuredOutputError) {
      console.error(
        `MODEL FAILURE: ${err.message}\nThe thread is resumable: npm run approvals -- list`,
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
