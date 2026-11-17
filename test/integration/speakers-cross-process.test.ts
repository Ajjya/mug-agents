import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../../src/mongo/indexes.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

/**
 * Resume across processes: every step is its own OS process (built output, scripted model, the real
 * MongoDB checkpointer). A run interrupted for approval in one process is decided in another, and a
 * crash between writing the request and suspending is repaired by a third. No step may duplicate a
 * draft or a request, and no resume may call the model again.
 */
const OUT = 'dist-speakersproc';
let mongo: TestMongo;

beforeAll(async () => {
  const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.test-process.json', '--outDir', OUT], {
    encoding: 'utf8',
  });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  mongo = await openTestMongo();
  await ensureIndexes(mongo.db, new Logger('test'));
}, 180_000);

afterAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  await mongo.close();
});

interface Out {
  eventId?: string;
  status?: string;
  requestId?: string;
  threadId?: string;
  created?: number;
  modelCalls?: number;
  messages?: number;
  statuses?: string[];
  requests?: number;
  pending?: string[];
}

function step(args: string[], env: Record<string, string> = {}): Out {
  const r = spawnSync('node', [`${OUT}/test/support/speakers-process.js`, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      MONGODB_URI: mongo.uri,
      MONGODB_DB: mongo.dbName,
      ...env,
    },
    timeout: 60_000,
  });
  expect(r.status, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as Out;
}

describe('speakers: resume across processes', () => {
  it('interrupt in process A, approve in process B: no duplicates, no model call in B', () => {
    const { eventId = '' } = step(['seed']);
    const a = step(['run', eventId, '2026-10-31']);
    expect(a).toMatchObject({ status: 'awaiting_approval', created: 2, modelCalls: 2 });
    const b = step(['decide', a.requestId ?? '']);
    expect(b).toMatchObject({ status: 'completed', modelCalls: 0 });
    const c = step(['run', eventId, '2026-10-31']);
    expect(c).toMatchObject({ status: 'completed', created: 0, modelCalls: 0 });
    expect(step(['counts', eventId])).toMatchObject({
      messages: 2,
      statuses: ['approved', 'approved'],
    });
  });

  it('a crash between the request and the suspend is repaired in another process', () => {
    const { eventId = '' } = step(['seed', 'Second']);
    const before = step(['counts', eventId]).requests ?? 0;
    const crashed = step(['run', eventId, '2026-10-31'], { CRASH_AFTER_REQUEST: '1' });
    expect(crashed.status).toBe('crashed');
    const threadId = `event:${eventId}:speakers`;
    expect(step(['resume', threadId])).toMatchObject({ status: 'resumed', modelCalls: 0 });
    const counts = step(['counts', eventId]);
    expect(counts.messages).toBe(2);
    expect((counts.requests ?? 0) - before).toBe(1);
    const pendingForThis = counts.pending ?? [];
    expect(step(['decide', pendingForThis.at(-1) ?? ''])).toMatchObject({ status: 'completed' });
    expect(step(['counts', eventId]).statuses).toEqual(['approved', 'approved']);
  });
});
