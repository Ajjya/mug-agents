import { inspect } from 'node:util';
import { type DynamicModule, Global, Module, type LoggerService } from '@nestjs/common';
import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config/env.schema.js';

/**
 * Single logging seam: call sites use Nest's Logger (or inject AppLogger); this class is the
 * only place that knows about pino, so tracing / cost metrics (M7) can be added here.
 * Policy: never log full document bodies at info level — log ids and counts.
 */
export class AppLogger implements LoggerService {
  private readonly base: Logger;

  constructor(config: AppConfig) {
    this.base = pino({ level: config.LOG_LEVEL, base: { service: 'mug-agents' } });
  }

  private emit(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    params: unknown[],
  ): void {
    // Nest passes the context name as the last string argument.
    const last = params.at(-1);
    const context = typeof last === 'string' ? last : undefined;
    const rest = context === undefined ? params : params.slice(0, -1);
    const details = rest.map((p) => (p instanceof Error ? pino.stdSerializers.err(p) : p));

    let msg: string;
    const fields: Record<string, unknown> = { context };
    if (typeof message === 'string') {
      msg = message;
    } else if (message instanceof Error) {
      msg = message.message;
      fields['err'] = pino.stdSerializers.err(message);
    } else {
      // inspect never throws on circular structures, unlike JSON.stringify.
      msg = inspect(message, { depth: 4, breakLength: Infinity });
    }
    if (details.length > 0) fields['details'] = details;
    this.base[level](fields, msg);
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

/** The logger is built once by the caller and provided as a value: exactly one instance exists. */
@Global()
@Module({})
export class LoggerModule {
  static forValue(logger: AppLogger): DynamicModule {
    return {
      module: LoggerModule,
      providers: [{ provide: AppLogger, useValue: logger }],
      exports: [AppLogger],
    };
  }
}
