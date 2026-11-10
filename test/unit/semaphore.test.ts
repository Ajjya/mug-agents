import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/llm/semaphore.js';

describe('Semaphore', () => {
  it('never allows more than the limit in flight, and runs everything', async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sem.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight--;
          return i;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(sem.peak).toBe(3);
    expect(sem.active).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(sem.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(sem.active).toBe(0);
  });

  it('rejects an invalid limit', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});
