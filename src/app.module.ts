import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type AppRole, type Env, validateEnv } from './config/env.js';
import { dataSourceOptions } from './database/data-source-options.js';
import { CredentialsModule } from './modules/credentials/credentials.module.js';
import { EventsModule } from './modules/events/execution-events.service.js';
import { RealtimeModule } from './modules/events/realtime.gateway.js';
import { ExecutionsModule } from './modules/executions/executions.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { NodeTypesModule } from './modules/node-types/node-types.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.controller.js';
import { WorkerModule } from './modules/worker/worker.module.js';
import { WorkflowsModule } from './modules/workflows/workflows.module.js';
import { redisOptionsFromUrl } from './redis/redis-options.js';

@Module({})
export class AppModule {
  /**
   * api: REST, webhooks, WebSocket. worker: consumes the queue.
   * all: both in one process (local development, tests).
   */
  static forRole(role: AppRole): DynamicModule {
    const serveHttp = role !== 'worker';
    const runWorker = role !== 'api';
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          validate: validateEnv,
        }),
        TypeOrmModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) =>
            dataSourceOptions({
              DATABASE_URL: config.get('DATABASE_URL', { infer: true }),
              DB_MIGRATIONS_RUN: config.get('DB_MIGRATIONS_RUN', {
                infer: true,
              }),
              DB_LOGGING: config.get('DB_LOGGING', { infer: true }),
            }),
        }),
        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (config: ConfigService<Env, true>) => ({
            connection: redisOptionsFromUrl(
              config.get('REDIS_URL', { infer: true }),
            ),
            prefix: 'flow',
          }),
        }),
        EventsModule,
        NodeTypesModule,
        CredentialsModule,
        WorkflowsModule,
        ExecutionsModule,
        ...(serveHttp ? [WebhooksModule, RealtimeModule] : []),
        ...(runWorker ? [WorkerModule] : []),
      ],
      controllers: serveHttp ? [HealthController] : [],
    };
  }
}
