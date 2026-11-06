import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { LoggerModule } from './logging/logger.module.js';
import { MongoModule } from './mongo/mongo.module.js';
import { RepositoriesModule } from './repositories/repositories.module.js';

@Module({
  imports: [ConfigModule, LoggerModule, MongoModule, RepositoriesModule, HealthModule],
})
export class AppModule {}
