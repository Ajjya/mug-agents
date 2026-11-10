/** Caps concurrent async work. Shared by every caller of one provider, so the limit is process-wide. */
export class Semaphore {
  private inFlight = 0;
  private maxObserved = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Semaphore limit must be an integer >= 1, got ${String(limit)}`);
    }
  }

  get active(): number {
    return this.inFlight;
  }

  /** Highest concurrency ever observed (for tests and diagnostics). */
  get peak(): number {
    return this.maxObserved;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.inFlight++;
    }
    this.maxObserved = Math.max(this.maxObserved, this.inFlight);
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next)
        next(); // hand the slot straight to the next waiter: inFlight is unchanged
      else this.inFlight--;
    }
  }
}
