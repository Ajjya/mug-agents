import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.module.js';
import { ConfigError } from './config/env.schema.js';
import { AppLogger } from './logging/logger.module.js';

async function bootstrap(): Promise<void> {
  // Validate configuration first so a bad env produces a readable list (no logger yet).
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // One structured logger from the very first line; no buffering, so startup logs are never lost.
  const logger = new AppLogger(config);
  let app: INestApplication | undefined;
  try {
    // abortOnError: false so startup failures (e.g. MongoDB unreachable) reach the catch below.
    app = await NestFactory.create(AppModule, { abortOnError: false, logger });
    app.enableShutdownHooks();
    await app.listen(config.PORT);
  } catch (err) {
    logger.fatal('Startup failed', err instanceof Error ? err : new Error(String(err)));
    // Release anything that was initialised (e.g. the MongoClient) before exiting.
    await app?.close().catch(() => undefined);
    process.exit(1);
  }
}

void bootstrap();
