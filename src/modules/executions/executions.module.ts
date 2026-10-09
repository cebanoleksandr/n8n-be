import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { ExecutionStep } from './execution-step.entity.js';
import { Execution } from './execution.entity.js';
import { ExecutionsController } from './executions.controller.js';
import { ExecutionsService } from './executions.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Execution, ExecutionStep]),
    WorkflowsModule,
  ],
  controllers: [ExecutionsController],
  providers: [ExecutionsService],
})
export class ExecutionsModule {}
