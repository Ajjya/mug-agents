import { Controller, Get, Module } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TerminusModule } from '@nestjs/terminus';
import { MongoHealthIndicator } from '../mongo/mongo.health.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongo: MongoHealthIndicator,
  ) {}

  /** Liveness: the process is up. Must not touch MongoDB. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /** Readiness: dependencies are reachable. 503 when MongoDB is down. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.mongo.isHealthy()]);
  }
}

@Module({ imports: [TerminusModule], controllers: [HealthController] })
export class HealthModule {}
