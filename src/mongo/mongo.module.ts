import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { type Db, MongoClient } from 'mongodb';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { ensureIndexes } from './indexes.js';
import { MONGO_CLIENT, MONGO_DB } from './tokens.js';
import { MongoHealthIndicator } from './mongo.health.js';

@Injectable()
export class MongoLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Mongo');

  constructor(
    @Inject(MONGO_CLIENT) private readonly client: MongoClient,
    @Inject(MONGO_DB) private readonly db: Db,
  ) {}

  /** Fail fast: any error here aborts application startup. */
  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await this.db.command({ ping: 1 });
    this.logger.log(`connected to database "${this.db.databaseName}"`);
    await ensureIndexes(this.db, this.logger);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`closing MongoDB client${signal ? ` (${signal})` : ''}`);
    await this.client.close();
  }
}

@Global()
@Module({
  imports: [TerminusModule],
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [APP_CONFIG],
      // Not connected here; MongoLifecycle connects in onModuleInit.
      useFactory: (config: AppConfig) =>
        new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 }),
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT, APP_CONFIG],
      useFactory: (client: MongoClient, config: AppConfig) => client.db(config.MONGODB_DB),
    },
    MongoLifecycle,
    MongoHealthIndicator,
  ],
  exports: [MONGO_CLIENT, MONGO_DB, MongoHealthIndicator],
})
export class MongoModule {}

export { MONGO_CLIENT, MONGO_DB };
