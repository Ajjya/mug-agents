import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { RetrievalModule } from './retrieval/retrieval.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/env.schema.js';
import { HealthModule } from './health/health.module.js';
import type { AppLogger } from './logging/logger.module.js';
import { LoggerModule } from './logging/logger.module.js';
import { LlmModule } from './llm/llm.module.js';
import { MongoModule } from './mongo/mongo.module.js';
import { RepositoriesModule } from './repositories/repositories.module.js';

@Module({})
export class AppModule {
  /** Config and logger are built once (main.ts) and shared with the container as values. */
  static register(
    config: AppConfig,
    logger: AppLogger,
    /** Modules only some entry points load (the inbox CLI): nothing else boots them. */
    extraImports: NonNullable<ModuleMetadata['imports']> = [],
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forValue(config),
        LoggerModule.forValue(logger),
        LlmModule.register(),
        MongoModule,
        RepositoriesModule,
        ApprovalsModule,
        RetrievalModule,
        HealthModule,
        ...extraImports,
      ],
    };
  }
}
