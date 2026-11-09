import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/env.schema.js';
import { HealthModule } from './health/health.module.js';
import type { AppLogger } from './logging/logger.module.js';
import { LoggerModule } from './logging/logger.module.js';
import { MongoModule } from './mongo/mongo.module.js';
import { RepositoriesModule } from './repositories/repositories.module.js';

@Module({})
export class AppModule {
  /** Config and logger are built once (main.ts) and shared with the container as values. */
  static register(config: AppConfig, logger: AppLogger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forValue(config),
        LoggerModule.forValue(logger),
        MongoModule,
        RepositoriesModule,
        HealthModule,
      ],
    };
  }
}
