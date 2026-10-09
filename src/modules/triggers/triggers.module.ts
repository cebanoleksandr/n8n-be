import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../../queue/queue.js';
import { WorkflowVersion } from '../workflows/workflow-version.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';
import { TriggersService } from './triggers.service.js';
import { Webhook } from './webhook.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Webhook, Workflow, WorkflowVersion]),
    QueueModule,
  ],
  providers: [TriggersService],
  exports: [TriggersService],
})
export class TriggersModule {}
