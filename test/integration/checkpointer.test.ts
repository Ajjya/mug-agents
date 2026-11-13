import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../../src/config/config.module.js';
import { parseEnv } from '../../src/config/env.schema.js';
import {
  CHECKPOINTER,
  CHECKPOINT_RETENTION,
  CheckpointerModule,
  createCheckpointer,
} from '../../src/graph/checkpointer.module.js';
import { CheckpointRetention } from '../../src/graph/retention.js';
import { LoggerModule, AppLogger } from '../../src/logging/logger.module.js';
import { COLLECTIONS, INDEXES, ensureIndexes } from '../../src/mongo/indexes.js';
import { MONGO_CLIENT } from '../../src/mongo/tokens.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await openTestMongo();
  await ensureIndexes(mongo.db, new Logger('test'));
  // Let the TTL monitor run every second instead of every minute, so expiry is observable.
  await mongo.client.db('admin').command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
});
afterAll(async () => {
  await mongo.close();
});

const State = Annotation.Root({
  log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

function tinyGraph(saver: ReturnType<typeof createCheckpointer>) {
  return new StateGraph(State)
    .addNode('start', () => ({ log: ['start'] }))
    .addNode('ask', () => {
      const answer = interrupt<string, string>('proceed?');
      return { log: [`answer:${answer}`] };
    })
    .addEdge(START, 'start')
    .addEdge('start', 'ask')
    .addEdge('ask', END)
    .compile({ checkpointer: saver });
}

const count = (collection: string, threadId: string): Promise<number> =>
  mongo.db.collection(collection).countDocuments({ thread_id: threadId });

describe('MongoDB checkpointer', () => {
  it('uses the application MongoClient, not a second one', async () => {
    const saver = createCheckpointer(mongo.client, mongo.db);
    expect(Reflect.get(saver, 'client')).toBe(mongo.client);

    // Same through the Nest module: the provider is built from the injected MONGO_CLIENT.
    const config = parseEnv({
      NODE_ENV: 'test',
      MONGODB_URI: mongo.uri,
      MONGODB_DB: mongo.dbName,
      LOG_LEVEL: 'silent',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forValue(config),
        LoggerModule.forValue(new AppLogger(config)),
        CheckpointerModule,
      ],
    }).compile();
    await moduleRef.init();
    try {
      const injected = moduleRef.get<object>(CHECKPOINTER, { strict: false });
      expect(Reflect.get(injected, 'client')).toBe(moduleRef.get(MONGO_CLIENT, { strict: false }));
      expect(moduleRef.get(CHECKPOINT_RETENTION, { strict: false })).toBeInstanceOf(
        CheckpointRetention,
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('stores checkpoints in the prefixed graph_* collections', async () => {
    const graph = tinyGraph(createCheckpointer(mongo.client, mongo.db));
    await graph.invoke({}, { configurable: { thread_id: 'names-test' } });
    expect(await count(COLLECTIONS.graphCheckpoints, 'names-test')).toBeGreaterThan(0);
    expect(await mongo.db.listCollections({ name: 'checkpoints' }).toArray()).toHaveLength(0);
  });

  it('declares its indexes in INDEXES, including the expire_at TTL index', async () => {
    expect(INDEXES.graph_checkpoints.map((i) => i.name)).toContain('graph_checkpoints_expire_at');
    const names = (await mongo.db.collection(COLLECTIONS.graphCheckpoints).indexes()).map(
      (i) => i.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['thread_ns_checkpoint_idx', 'graph_checkpoints_expire_at']),
    );
  });
});

describe('checkpoint retention', () => {
  it('expires a completed thread, and never a thread still waiting on a decision (backdated)', async () => {
    const saver = createCheckpointer(mongo.client, mongo.db);
    const graph = tinyGraph(saver);
    const retention = new CheckpointRetention(mongo.db, 30);
    const done = { configurable: { thread_id: 'done-thread' } };
    const paused = { configurable: { thread_id: 'paused-thread' } };

    // done-thread runs to completion; paused-thread stops at interrupt().
    await graph.invoke({}, done);
    await graph.invoke(new Command({ resume: 'yes' }), done);
    await graph.invoke({}, paused);

    // Make the paused thread look two months old, far past the 30-day retention.
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    for (const c of [COLLECTIONS.graphCheckpoints, COLLECTIONS.graphCheckpointWrites]) {
      await mongo.db
        .collection(c)
        .updateMany({ thread_id: 'paused-thread' }, { $set: { upserted_at: longAgo } });
    }
    expect(await retention.inFlightThreadIds()).toEqual(
      expect.arrayContaining(['done-thread', 'paused-thread']),
    );

    // Completion: stamp done-thread with an expiry that is already in the past.
    await retention.scheduleExpiry('done-thread', new Date(Date.now() - 40 * 86_400_000));
    const inFlight = await retention.inFlightThreadIds();
    expect(inFlight).toContain('paused-thread');
    expect(inFlight).not.toContain('done-thread');

    const gone = async (): Promise<boolean> =>
      (await count(COLLECTIONS.graphCheckpoints, 'done-thread')) === 0 &&
      (await count(COLLECTIONS.graphCheckpointWrites, 'done-thread')) === 0;
    const deadline = Date.now() + 30_000;
    while (!(await gone()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    expect(await gone()).toBe(true);

    // The paused thread survived the TTL monitor and still resumes to completion.
    expect(await count(COLLECTIONS.graphCheckpoints, 'paused-thread')).toBeGreaterThan(0);
    const resumed = await graph.invoke(new Command({ resume: 'later' }), paused);
    expect(resumed.log).toEqual(['start', 'answer:later']);
  }, 60_000);

  it('does not stamp or touch other threads, and cancelExpiry makes a thread permanent again', async () => {
    const graph = tinyGraph(createCheckpointer(mongo.client, mongo.db));
    const retention = new CheckpointRetention(mongo.db, 30);
    for (const id of ['keep-a', 'keep-b'])
      await graph.invoke({}, { configurable: { thread_id: id } });

    const at = await retention.scheduleExpiry('keep-a', new Date('2030-01-01T00:00:00Z'));
    expect(at.toISOString()).toBe('2030-01-31T00:00:00.000Z');
    expect(
      await mongo.db
        .collection(COLLECTIONS.graphCheckpoints)
        .countDocuments({ thread_id: 'keep-b', expire_at: { $exists: true } }),
    ).toBe(0);
    expect(await retention.inFlightThreadIds()).toContain('keep-b');
    expect(await retention.inFlightThreadIds()).not.toContain('keep-a');

    await retention.cancelExpiry('keep-a');
    expect(await retention.inFlightThreadIds()).toContain('keep-a');
  });
});
