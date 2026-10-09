import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TriggersModule } from '../triggers/triggers.module.js';
import { WorkflowVersion } from './workflow-version.entity.js';
import { Workflow } from './workflow.entity.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, WorkflowVersion]),
    TriggersModule,
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
