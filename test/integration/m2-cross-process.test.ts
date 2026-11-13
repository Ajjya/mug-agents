import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, ensureIndexes } from '../../src/mongo/indexes.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

/**
 * The milestone's defining tests. Every step runs in its OWN OS process (the built output of the real
 * code, a stub model, the real MongoDB checkpointer). A thread interrupted in one process has to
 * resume to completion in another; a same-process resume would not prove the checkpointer works.
 */
const OUT = 'dist-m2proc';
let mongo: TestMongo;

beforeAll(async () => {
  const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.test-process.json'], { encoding: 'utf8' });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  mongo = await openTestMongo();
  await ensureIndexes(mongo.db, new Logger('test'));
}, 180_000);

afterAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  await mongo.close();
});

interface Out {
  status?: string;
  kind?: string;
  requestId?: string;
  threadId?: string;
  outcome?: string;
  persisted?: { created: number; skipped: number };
  modelCalls: string[];
  thread?: { status: string; runId?: string; outcome?: string };
  pending?: { id: string; threadId: string; orphan: boolean }[];
  resumable?: { threadId: string; failedNode?: string; runId?: string }[];
  tasks?: number;
  requests?: number;
  decisions?: number;
}

/** Runs one step in a fresh process and parses its single JSON line. */
function step(args: string[], env: Record<string, string> = {}): Out {
  const r = spawnSync('node', [`${OUT}/test/support/m2-process.js`, ...args], {
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
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Out;
}

const inDays = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const eventDate = inDays(60);
const counts = () => step(['counts']);
const count = (collection: string, filter: Record<string, unknown> = {}) =>
  mongo.db.collection(collection).countDocuments(filter);

describe('resume across processes', () => {
  it('a plan interrupted in one process is approved and finished in another', async () => {
    // Process 1: run to the interrupt, then the process exits.
    const first = step(['plan', 'Cross-process approve', eventDate]);
    expect(first.status).toBe('awaiting_approval');
    expect(first.modelCalls).toEqual(['generateTimeline', 'generateChecklist']);
    const { requestId, threadId } = first;
    if (!requestId || !threadId) throw new Error('no request/thread');
    expect(await count(COLLECTIONS.tasks)).toBe(0); // nothing persisted before the decision
    expect(await count(COLLECTIONS.approvalRequests, { status: 'pending' })).toBeGreaterThanOrEqual(
      1,
    );
    expect(await count(COLLECTIONS.graphCheckpoints, { thread_id: threadId })).toBeGreaterThan(0);

    // Process 2 (a different process): decide and resume. The stub model is NOT asked again.
    const second = step(['decide', requestId, 'approve']);
    expect(second).toMatchObject({
      status: 'completed',
      outcome: 'persisted',
      persisted: { created: 5, skipped: 0 },
    });
    expect(second.modelCalls).toEqual([]);
    expect(await count(COLLECTIONS.tasks)).toBe(5);

    // Process 3: resuming the same thread again changes nothing.
    expect(step(['resume', threadId]).status).toBe('already_completed');
    expect(await count(COLLECTIONS.tasks)).toBe(5);

    // Finished threads are stamped to expire; the decision is on record.
    expect(
      await count(COLLECTIONS.graphCheckpoints, {
        thread_id: threadId,
        expire_at: { $exists: true },
      }),
    ).toBeGreaterThan(0);
    expect(counts().decisions).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('edit in the second process persists the edited plan; reject persists nothing', async () => {
    const edit = step(['plan', 'Cross-process edit', inDays(61)]);
    const reject = step(['plan', 'Cross-process reject', inDays(62)]);
    if (!edit.requestId || !reject.requestId) throw new Error('no requests');
    const tasksBefore = await count(COLLECTIONS.tasks);

    expect(step(['decide', edit.requestId, 'edit']).persisted).toEqual({ created: 1, skipped: 0 });
    expect(await count(COLLECTIONS.tasks, { title: 'Edited in another process' })).toBe(1);
    expect(await count(COLLECTIONS.tasks)).toBe(tasksBefore + 1);

    expect(step(['decide', reject.requestId, 'reject']).outcome).toBe('rejected');
    expect(await count(COLLECTIONS.tasks)).toBe(tasksBefore + 1);
    expect(await count(COLLECTIONS.events, { notes: /Plan rejected: not this one/ })).toBe(1);
  }, 120_000);

  it('planning again from yet another process finds the waiting thread: no second thread, no model call', () => {
    const first = step(['plan', 'Cross-process waiting', inDays(63)]);
    const again = step(['plan', 'Cross-process waiting', inDays(63)]);
    expect(again).toMatchObject({
      status: 'awaiting_approval',
      alreadyWaiting: true,
      threadId: first.threadId,
      requestId: first.requestId,
    });
    expect(again.modelCalls).toEqual([]);
  }, 120_000);
});

describe('resume after a provider failure, in a new process', () => {
  it('a run killed by a provider failure is listed as resumable; resuming re-runs only the failed node', async () => {
    // Process 1: the timeline node fails with a 503. The run dies, the thread keeps its state.
    const failed = step(['plan', 'Cross-process outage', inDays(64)], {
      STUB_FAIL_NODE: 'generateChecklist',
    });
    expect(failed).toMatchObject({ status: 'failed', kind: 'ProviderUnavailableError' });
    expect(failed.modelCalls).toEqual(['generateTimeline', 'generateChecklist']);
    const threadId = failed.threadId ?? '';
    const tasksBefore = await count(COLLECTIONS.tasks);

    // Process 2: the list shows it as resumable, with the node that failed.
    const listing = step(['list']);
    expect(listing.resumable).toContainEqual(
      expect.objectContaining({ threadId, failedNode: 'generateChecklist' }),
    );
    const runId = listing.resumable?.find((t) => t.threadId === threadId)?.runId;
    expect(runId).toBeTruthy();

    // Process 3: the provider is back. Only the failed node runs again: the timeline step, which had
    // completed, is not asked for again, and the run keeps its identity (milestones not recomputed).
    const resumed = step(['resume', threadId]);
    expect(resumed.status).toBe('resumed');
    expect(resumed.modelCalls).toEqual(['generateChecklist']);
    expect(resumed.thread).toMatchObject({ status: 'awaiting_decision', runId });
    expect(await count(COLLECTIONS.tasks)).toBe(tasksBefore); // nothing written by a failed run

    // Process 4 and 5: approve, then resume again: five tasks, never ten.
    const pending = step(['list']).pending?.find((p) => p.threadId === threadId);
    expect(pending?.orphan).toBe(false);
    expect(step(['decide', pending?.id ?? '', 'approve']).persisted).toEqual({
      created: 5,
      skipped: 0,
    });
    expect(step(['resume', threadId]).status).toBe('already_completed');
    expect(await count(COLLECTIONS.tasks)).toBe(tasksBefore + 5);
  }, 180_000);

  it('a failure in the FIRST model node: the computed milestones survive and are not recomputed', () => {
    const failed = step(['plan', 'Cross-process outage early', inDays(65)], {
      STUB_FAIL_NODE: 'generateTimeline',
    });
    expect(failed.status).toBe('failed');
    const threadId = failed.threadId ?? '';
    const before = step(['list']).resumable?.find((t) => t.threadId === threadId);
    expect(before).toMatchObject({ failedNode: 'generateTimeline' });
    expect(before?.runId).toBeTruthy(); // set by normaliseBrief, which completed before the failure

    const resumed = step(['resume', threadId]);
    expect(resumed.thread?.runId).toBe(before?.runId); // normaliseBrief did not run again
    expect(resumed.modelCalls).toEqual(['generateTimeline', 'generateChecklist']);
    expect(resumed.thread?.status).toBe('awaiting_decision');
  }, 120_000);
});
