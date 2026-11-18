import 'reflect-metadata';
import type { INestApplicationContext, ModuleMetadata } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.module.js';
import { ConfigError, type AppConfig } from '../src/config/env.schema.js';
import { AppLogger } from '../src/logging/logger.module.js';

/** Boots the application context (config, Mongo, indexes), runs `fn`, closes, sets the exit code. */
export function runCli(
  fn: (app: INestApplicationContext, config: AppConfig) => Promise<number>,
  onError: (err: unknown) => number | undefined = () => undefined,
  /** Modules only this command loads (e.g. the inbox). A module that fails to boot fails the command. */
  extraImports: NonNullable<ModuleMetadata['imports']> = [],
): void {
  const main = async (): Promise<number> => {
    let config: AppConfig;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
    const logger = new AppLogger(config);
    const app = await NestFactory.createApplicationContext(
      AppModule.register(config, logger, extraImports),
      {
        logger,
        abortOnError: false,
      },
    );
    try {
      return await fn(app, config);
    } catch (err) {
      const code = onError(err);
      if (code !== undefined) return code;
      throw err;
    } finally {
      await app.close();
    }
  };
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
