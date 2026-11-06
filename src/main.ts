import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigError } from './config/env.schema.js';
import { loadConfig } from './config/config.module.js';
import { AppLogger } from './logging/logger.module.js';

async function bootstrap(): Promise<void> {
  // Validate configuration before anything else so a bad env produces a readable list.
  const config = loadConfig();

  // abortOnError: false so startup failures (e.g. MongoDB unreachable) reach the catch below.
  const app = await NestFactory.create(AppModule, { abortOnError: false, bufferLogs: true });
  app.useLogger(app.get(AppLogger));
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error('Startup failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
