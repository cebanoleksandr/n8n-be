import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type Env, validateEnv } from './config/env.js';
import { dataSourceOptions } from './database/data-source-options.js';
import { ExecutionsModule } from './modules/executions/executions.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { NodeTypesModule } from './modules/node-types/node-types.module.js';
import { WorkflowsModule } from './modules/workflows/workflows.module.js';

@Module({
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
          DB_MIGRATIONS_RUN: config.get('DB_MIGRATIONS_RUN', { infer: true }),
          DB_LOGGING: config.get('DB_LOGGING', { infer: true }),
        }),
    }),
    NodeTypesModule,
    WorkflowsModule,
    ExecutionsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
