import { Global, Inject, Injectable, Module, type LoggerService } from '@nestjs/common';
import { pino, type Logger } from 'pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';

/**
 * Single logging seam: call sites use Nest's Logger (or inject AppLogger); this class is the
 * only place that knows about pino, so tracing / cost metrics (M7) can be added here.
 * Policy: never log full document bodies at info level — log ids and counts.
 */
@Injectable()
export class AppLogger implements LoggerService {
  private readonly base: Logger;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.base = pino({ level: config.LOG_LEVEL, base: { service: 'mug-agents' } });
  }

  private emit(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    params: unknown[],
  ): void {
    const last = params.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    const extra = params.filter((p) => typeof p !== 'string' || p !== context);
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    this.base[level]({ context, ...(extra.length ? { details: extra } : {}) }, msg);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }
}

@Global()
@Module({ providers: [AppLogger], exports: [AppLogger] })
export class LoggerModule {}
