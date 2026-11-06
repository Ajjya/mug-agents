import { Global, Module } from '@nestjs/common';
import { type AppConfig, parseEnv } from './env.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** The only place in the codebase that reads process.env. */
export function loadConfig(): AppConfig {
  return parseEnv(process.env);
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadConfig }],
  exports: [APP_CONFIG],
})
export class ConfigModule {
  /** Variant for tests: inject an explicit config without touching process.env. */
  static forValue(config: AppConfig) {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
