import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { AppLogger } from '../logging/logger.module.js';
import type { LlmProvider } from './model.types.js';
import { OllamaProvider } from './ollama.provider.js';
import { Semaphore } from './semaphore.js';
import { type StructuredCall, callStructured } from './structured.js';

export const LLM_PROVIDERS_TOKEN = Symbol('LLM_PROVIDERS');
export const STRUCTURED_CALL = Symbol('STRUCTURED_CALL');

export type ProviderRegistry = Record<
  AppConfig['LLM_MODEL_LADDER'][number]['provider'],
  LlmProvider
>;

/** Builds the provider registry from config. Adding a vendor = one entry here (and in the env schema). */
export function buildProviders(
  config: AppConfig,
  overrides: Partial<ProviderRegistry> = {},
): ProviderRegistry {
  return {
    ollama: new OllamaProvider({
      baseUrl: config.OLLAMA_BASE_URL,
      apiKey: config.OLLAMA_API_KEY,
      // One semaphore per provider: nothing in the process can exceed the provider's limit.
      semaphore: new Semaphore(config.OLLAMA_MAX_CONCURRENCY),
    }),
    ...overrides,
  };
}

export function buildStructuredCall(
  config: AppConfig,
  providers: ProviderRegistry,
  logger: AppLogger,
  ladder: AppConfig['LLM_MODEL_LADDER'] = config.LLM_MODEL_LADDER,
): StructuredCall {
  return (schema, prompt, options) =>
    callStructured(schema, prompt, options, {
      ladder,
      provider: (name) => providers[name],
      maxAttempts: config.LLM_MAX_ATTEMPTS,
      timeoutMs: config.LLM_TIMEOUT_MS,
      logger,
    });
}

@Global()
@Module({})
export class LlmModule {
  static register(): DynamicModule {
    return {
      module: LlmModule,
      providers: [
        {
          provide: LLM_PROVIDERS_TOKEN,
          useFactory: (c: AppConfig) => buildProviders(c),
          inject: [APP_CONFIG],
        },
        {
          provide: STRUCTURED_CALL,
          useFactory: (c: AppConfig, p: ProviderRegistry, l: AppLogger) =>
            buildStructuredCall(c, p, l),
          inject: [APP_CONFIG, LLM_PROVIDERS_TOKEN, AppLogger],
        },
      ],
      exports: [LLM_PROVIDERS_TOKEN, STRUCTURED_CALL],
    };
  }
}
