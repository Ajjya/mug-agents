import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { Db } from 'mongodb';
import { MONGO_DB } from './tokens.js';

@Injectable()
export class MongoHealthIndicator {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly indicators: HealthIndicatorService,
  ) {}

  isHealthy(key = 'mongodb') {
    return this.indicators
      .check(key)
      .attempt(async ({ signal }) => {
        // Abort on timeout so timed-out probes do not pile up behind server selection.
        await this.db.command({ ping: 1 }, { signal });
      })
      .withTimeout(2_000);
  }
}
