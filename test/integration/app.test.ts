import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, ConfigModule } from '../../src/config/config.module.js';
import type { AppConfig } from '../../src/config/env.schema.js';
import { HealthModule } from '../../src/health/health.module.js';
import { AppLogger, LoggerModule } from '../../src/logging/logger.module.js';
import { INDEXES } from '../../src/mongo/indexes.js';
import { MongoModule } from '../../src/mongo/mongo.module.js';
import { RepositoriesModule } from '../../src/repositories/repositories.module.js';
import { MONGOD_VERSION } from '../support/mongod-version.js';
import { openTestMongo, type TestMongo } from '../support/mongo-test.js';

const httpOf = (app: INestApplication) => app.getHttpServer() as Server;

const config = (uri: string, db: string): AppConfig => ({
  NODE_ENV: 'test',
  PORT: 0,
  MONGODB_URI: uri,
  MONGODB_DB: db,
  LOG_LEVEL: 'silent',
});

async function createApp(cfg: AppConfig): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forValue(cfg),
      LoggerModule.forValue(new AppLogger(cfg)),
      MongoModule,
      RepositoriesModule,
      HealthModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('startup indexes', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  beforeAll(async () => {
    mongo = await openTestMongo();
    app = await createApp(config(mongo.uri, mongo.dbName));
  });
  afterAll(async () => {
    await app.close();
    await mongo.close();
  });

  it('creates all required indexes on first start, and a second start is idempotent', async () => {
    const expected = Object.entries(INDEXES).flatMap(([col, idx]) =>
      idx.map((i) => `${col}.${String(i.name)}`),
    );
    const actual = async () =>
      (
        await Promise.all(
          Object.keys(INDEXES).map(async (col) =>
            (await mongo.db.collection(col).indexes()).map((i) => `${col}.${String(i.name)}`),
          ),
        )
      )
        .flat()
        .filter((n) => !n.endsWith('._id_'))
        .sort();
    expect(await actual()).toEqual(expected.sort());

    const speakerEmail = (await mongo.db.collection('speakers').indexes()).find(
      (i) => i.name === 'speakers_email_unique',
    );
    expect(speakerEmail).toMatchObject({ unique: true, sparse: true });

    const second = await createApp(config(mongo.uri, mongo.dbName));
    await second.close();
    expect(await actual()).toEqual(expected.sort());
  });

  it('GET /health/live and /health/ready return 200 when MongoDB is up', async () => {
    await request(httpOf(app)).get('/health/live').expect(200);
    const ready = await request(httpOf(app)).get('/health/ready').expect(200);
    expect(ready.body).toMatchObject({ status: 'ok' });
  });
});

describe('MongoDB goes down', () => {
  it('live stays 200 and ready becomes 503', async () => {
    const server = await MongoMemoryServer.create();
    const app = await createApp(config(server.getUri(), 'health_test'));
    try {
      await request(httpOf(app)).get('/health/ready').expect(200);
      await server.stop();
      await request(httpOf(app)).get('/health/live').expect(200);
      await request(httpOf(app)).get('/health/ready').expect(503);
    } finally {
      await app.close();
    }
  });
});

describe('test infrastructure', () => {
  it('runs against the pinned mongod version', async () => {
    const mongo = await openTestMongo();
    try {
      const info = await mongo.db.admin().serverInfo();
      expect(info['version']).toBe(MONGOD_VERSION);
    } finally {
      await mongo.close();
    }
  });
});

describe('single config and logger instances', () => {
  it('AppModule.register shares the exact objects main.ts built', async () => {
    const mongo = await openTestMongo();
    const cfg = config(mongo.uri, mongo.dbName);
    const logger = new AppLogger(cfg);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(cfg, logger)],
    }).compile();
    const app = moduleRef.createNestApplication();
    try {
      await app.init();
      expect(app.get(APP_CONFIG)).toBe(cfg);
      expect(app.get(AppLogger)).toBe(logger);
    } finally {
      await app.close();
      await mongo.close();
    }
  });
});

describe('fail-fast startup', () => {
  it('does not start when MongoDB is unreachable', async () => {
    await expect(createApp(config('mongodb://127.0.0.1:1', 'x'))).rejects.toThrow();
  }, 20_000);
});

describe('built application process', () => {
  const OUT = 'dist-test';
  beforeAll(() => {
    const r = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', OUT], {
      encoding: 'utf8',
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120_000);
  afterAll(() => {
    rmSync(OUT, { recursive: true, force: true });
  });

  const run = (env: Record<string, string>) =>
    spawnSync('node', [`${OUT}/main.js`], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', ...env },
      timeout: 30_000,
    });

  it('exits non-zero with a readable list when MONGODB_URI is missing', () => {
    const r = run({ MONGODB_DB: 'x', PORT: 'abc' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('MONGODB_URI');
    expect(r.stderr).toContain('PORT');
  });

  it('exits non-zero with a clear message when MongoDB is unreachable', () => {
    const r = run({ MONGODB_URI: 'mongodb://127.0.0.1:1', MONGODB_DB: 'x', LOG_LEVEL: 'error' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('Startup failed');
  }, 30_000);
});
