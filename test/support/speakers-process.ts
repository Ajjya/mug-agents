/**
 * A tiny CLI used ONLY by test/integration/speakers-cross-process.test.ts. Each invocation is its own
 * OS process on the same MongoDB (repositories + the real checkpointer) with a scripted model, so a
 * run can be interrupted in one process and decided in another. Prints one JSON line on stdout.
 *
 *   node speakers-process.js seed [nameSuffix]
 *   node speakers-process.js run <eventId> <YYYY-MM-DD>     env CRASH_AFTER_REQUEST=1 to crash there
 *   node speakers-process.js decide <requestId>
 *   node speakers-process.js resume <threadId>
 *   node speakers-process.js counts <eventId>
 */
import { MongoClient } from 'mongodb';
import {
  MongoApprovalDecisionsRepository,
  MongoApprovalRequestsRepository,
} from '../../src/approvals/approvals.repository.js';
import { createCheckpointer } from '../../src/graph/checkpointer.module.js';
import { CheckpointRetention } from '../../src/graph/retention.js';
import { MongoThreadLock } from '../../src/graph/thread-lock.js';
import { MongoEventsRepository } from '../../src/repositories/events.repository.js';
import { MongoMessagesRepository } from '../../src/repositories/messages.repository.js';
import { MongoOrganisationsRepository } from '../../src/repositories/organisations.repository.js';
import { MongoSpeakersRepository } from '../../src/repositories/speakers.repository.js';
import { MongoTasksRepository } from '../../src/repositories/tasks.repository.js';
import { buildSpeakersHarness } from './speakers-harness.js';
import { day, seed } from './speakers-workflow-suite.js';

const [, , command, a, b] = process.argv;
const uri = process.env['MONGODB_URI'];
const dbName = process.env['MONGODB_DB'];
if (!uri || !dbName) throw new Error('MONGODB_URI and MONGODB_DB are required');

const client = await new MongoClient(uri).connect();
const db = client.db(dbName);
const repos = {
  events: new MongoEventsRepository(db),
  speakers: new MongoSpeakersRepository(db),
  organisations: new MongoOrganisationsRepository(db),
  messages: new MongoMessagesRepository(db),
  tasks: new MongoTasksRepository(db),
  requests: new MongoApprovalRequestsRepository(db),
  decisions: new MongoApprovalDecisionsRepository(db),
};
const h = buildSpeakersHarness(repos, {
  saver: createCheckpointer(client, db),
  retention: new CheckpointRetention(db, 30),
  lock: new MongoThreadLock(db),
});
h.behaviour.crashAfterRequest = process.env['CRASH_AFTER_REQUEST'] === '1';
const out = (v: unknown): void => {
  console.log(JSON.stringify(v));
};

try {
  switch (command) {
    case 'seed': {
      const s = await seed(repos, [
        { name: `Wendeline Gooseberry ${a ?? ''}`.trim(), status: 'idea' },
        { name: `Ignatius Fogwhistle ${a ?? ''}`.trim(), status: 'idea' },
      ]);
      out({ eventId: s.eventId });
      break;
    }
    case 'run': {
      try {
        const r = await h.service.run(a ?? '', { now: day(b ?? '') });
        out({
          status: r.status,
          requestId: r.requestId,
          threadId: r.threadId,
          created: r.created.length,
          modelCalls: h.model.prompts.length,
        });
      } catch (err) {
        out({ status: 'crashed', error: err instanceof Error ? err.name : String(err) });
      }
      break;
    }
    case 'decide': {
      const r = await h.approvals.decide(a ?? '', { decision: 'approve' }, 'process-b');
      out({ status: r.thread.status, modelCalls: h.model.prompts.length });
      break;
    }
    case 'resume': {
      const r = await h.approvals.resumeThread(a ?? '');
      out({ status: r.status, modelCalls: h.model.prompts.length });
      break;
    }
    case 'counts': {
      const msgs = (await repos.messages.findByEventId(a ?? '')).items;
      out({
        messages: msgs.length,
        statuses: msgs.map((m) => m.status),
        requests: await repos.requests.count(),
        pending: (await repos.requests.findByStatus('pending')).items.map((r) => r._id),
      });
      break;
    }
    default:
      throw new Error(`unknown command ${String(command)}`);
  }
} finally {
  await client.close();
}
