import { type DynamicModule, Global, Module } from '@nestjs/common';
import { type AppConfig, parseEnv } from './env.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** The only place in the codebase that reads process.env. Called once, from main.ts. */
export function loadConfig(): AppConfig {
  return parseEnv(process.env);
}

/**
 * Config is built once by the caller (main.ts, or a test) and handed to the container as a value,
 * so exactly one AppConfig instance exists.
 */
@Global()
@Module({})
export class ConfigModule {
  static forValue(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
