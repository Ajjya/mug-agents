import { parseEnv } from '../../src/config/env.schema.js';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AppLogger } from '../../src/logging/logger.module.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = new AppLogger(
    parseEnv({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://x', MONGODB_DB: 'x', LOG_LEVEL: 'debug' }),
  );
  // Swap the pino destination for an in-memory stream.
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  (logger as unknown as { base: unknown }).base = pinoTo(sink);
  return { logger, lines };
}

import { pino } from 'pino';
const pinoTo = (stream: Writable) => pino({ level: 'debug' }, stream);

describe('AppLogger', () => {
  it('logs Error objects with message and stack instead of "{}"', () => {
    const { logger, lines } = capture();
    logger.error(new Error('boom'));
    expect(lines[0]).toMatchObject({ msg: 'boom', err: { message: 'boom' } });
    expect((lines[0]?.['err'] as { stack?: string }).stack).toContain('boom');
  });

  it('does not throw on circular messages', () => {
    const { logger, lines } = capture();
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => {
      logger.log(a);
    }).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('treats the last string argument as the context', () => {
    const { logger, lines } = capture();
    logger.log('hello', { x: 1 }, 'Ctx');
    expect(lines[0]).toMatchObject({ msg: 'hello', context: 'Ctx', details: [{ x: 1 }] });
  });
});
