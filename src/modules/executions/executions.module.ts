import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../../queue/queue.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { ExecutionStep } from './execution-step.entity.js';
import { Execution } from './execution.entity.js';
import { ExecutionsController } from './executions.controller.js';
import { ExecutionsService } from './executions.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Execution, ExecutionStep]),
    QueueModule,
    WorkflowsModule,
  ],
  controllers: [ExecutionsController],
  providers: [ExecutionsService],
  exports: [ExecutionsService, TypeOrmModule],
})
export class ExecutionsModule {}
