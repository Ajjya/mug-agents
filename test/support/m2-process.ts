/**
 * A tiny CLI used ONLY by test/integration/m2-cross-process.test.ts. Each invocation is its own OS
 * process wired to the same MongoDB (repositories + the real MongoDB checkpointer) and a
 * deterministic stub model, so a test can run a graph to its interrupt in one process, let that
 * process exit, and finish the run in another. Prints one JSON line on stdout.
 *
 *   node m2-process.js plan <theme> <dateIso>          env STUB_FAIL_NODE=<node> makes that node fail (503)
 *   node m2-process.js decide <requestId> approve|edit|reject
 *   node m2-process.js resume <threadId>
 *   node m2-process.js list
 *   node m2-process.js counts
 */
import { MongoClient } from 'mongodb';
import type { DecisionValue } from '../../src/approvals/approval.schema.js';
import { PlanRunInterruptedError } from '../../src/agents/planner/planner.service.js';
import {
  MongoApprovalDecisionsRepository,
  MongoApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { createCheckpointer } from '../../src/graph/checkpointer.module.js';
import { MongoThreadLock } from '../../src/graph/thread-lock.js';
import { CheckpointRetention } from '../../src/graph/retention.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoTasksRepository } from '../../src/repositories/tasks.repository.js';
import { buildHarness } from './planner-harness.js';

const [, , command, a, b] = process.argv;
const uri = process.env['MONGODB_URI'];
const dbName = process.env['MONGODB_DB'];
if (!uri || !dbName) throw new Error('MONGODB_URI and MONGODB_DB are required');

const client = await new MongoClient(uri).connect();
const db = client.db(dbName);
const repos = {
  events: new MongoEventsRepository(db),
  tasks: new MongoTasksRepository(db),
  requests: new MongoApprovalRequestsRepository(db),
  decisions: new MongoApprovalDecisionsRepository(db),
};
const h = buildHarness(repos, {
  saver: createCheckpointer(client, db),
  retention: new CheckpointRetention(db, 30),
  lock: new MongoThreadLock(db),
});
h.behaviour.failNode = process.env['STUB_FAIL_NODE'] || undefined;

const out = (value: unknown): void => {
  console.log(JSON.stringify(value));
};

try {
  switch (command) {
    case 'plan': {
      try {
        const r = await h.planner.startPlan({
          theme: a,
          date: b,
          format: 'talks',
          capacity: 80,
        });
        out({ ...r, modelCalls: h.modelCalls });
      } catch (err) {
        if (err instanceof PlanRunInterruptedError) {
          out({
            status: 'failed',
            kind: err.cause.name,
            threadId: err.threadId,
            modelCalls: h.modelCalls,
          });
        } else throw err;
      }
      break;
    }
    case 'decide': {
      const requestId = a ?? '';
      const request = await repos.requests.findById(requestId);
      if (!request) throw new Error('no such request');
      const decision: DecisionValue =
        b === 'approve'
          ? { decision: 'approve' }
          : b === 'reject'
            ? { decision: 'reject', reason: 'not this one' }
            : {
                decision: 'edit',
                editedPayload: {
                  ...request.payload,
                  checklist: [
                    { milestone: 'T-8w', title: 'Edited in another process', owner: 'organiser' },
                  ],
                },
              };
      const r = await h.approvals.decide(requestId, decision, 'process-b');
      out({
        status: r.thread.status,
        outcome: r.thread.outcome,
        persisted: r.thread.persisted,
        modelCalls: h.modelCalls,
      });
      break;
    }
    case 'resume': {
      const r = await h.approvals.resumeThread(a ?? '');
      out({
        status: r.status,
        thread:
          'thread' in r
            ? { status: r.thread.status, runId: r.thread.runId, outcome: r.thread.outcome }
            : undefined,
        modelCalls: h.modelCalls,
      });
      break;
    }
    case 'list': {
      const l = await h.approvals.list();
      out({
        pending: l.pending.map((p) => ({
          id: p.request._id,
          threadId: p.request.threadId,
          orphan: p.orphan,
        })),
        resumable: l.resumable.map((t) => ({
          threadId: t.threadId,
          failedNode: t.failedNode,
          runId: t.runId,
        })),
      });
      break;
    }
    case 'counts': {
      out({
        tasks: await repos.tasks.count(),
        requests: await repos.requests.count(),
        events: await repos.events.count(),
        decisions: await repos.decisions.count(),
      });
      break;
    }
    default:
      throw new Error(`unknown command ${String(command)}`);
  }
} finally {
  await client.close();
}
