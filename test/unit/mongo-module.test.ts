import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { ConfigModule } from '../../src/config/config.module.js';
import { parseEnv } from '../../src/config/env.schema.js';
import { MONGO_DB } from '../../src/mongo/tokens.js';
import { MongoModule } from '../../src/mongo/mongo.module.js';
import { HealthModule } from '../../src/health/health.module.js';
import { EVENTS_REPOSITORY } from '../../src/repositories/events.repository.js';
import { RepositoriesModule } from '../../src/repositories/repositories.module.js';

const cfg = parseEnv({
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:1', // never connected: these tests only compile the DI graph
  MONGODB_DB: 'x',
  LOG_LEVEL: 'silent',
});

@Module({
  providers: [{ provide: 'NEEDS_DB', inject: [MONGO_DB], useFactory: (db: Db) => db }],
})
class WithoutImport {}

@Module({
  imports: [MongoModule],
  providers: [{ provide: 'NEEDS_DB', inject: [MONGO_DB], useFactory: (db: Db) => db }],
})
class WithImport {}

describe('MongoModule is not global', () => {
  it('a module that does not import it cannot inject MONGO_DB', async () => {
    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forValue(cfg), MongoModule, WithoutImport],
      }).compile(),
    ).rejects.toThrow(/MONGO_DB|Nest can't resolve dependencies/);
  });

  it('a module that imports it can', async () => {
    const ref = await Test.createTestingModule({
      imports: [ConfigModule.forValue(cfg), WithImport],
    }).compile();
    expect(ref.get('NEEDS_DB', { strict: false })).toBeDefined();
  });

  it('the repositories and health modules import it themselves', async () => {
    const ref = await Test.createTestingModule({
      imports: [ConfigModule.forValue(cfg), RepositoriesModule, HealthModule],
    }).compile();
    expect(ref.get(EVENTS_REPOSITORY)).toBeDefined();
  });
});
