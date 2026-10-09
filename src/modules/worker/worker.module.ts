import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../../queue/queue.js';
import { BinaryDataModule } from '../binary-data/binary-data.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { ExecutionsModule } from '../executions/executions.module.js';
import { WorkflowVersion } from '../workflows/workflow-version.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';
import { ExecutionExecutor } from './execution-executor.service.js';
import { ExecutionPruner } from './execution-pruner.service.js';
import { WorkflowProcessor } from './workflow.processor.js';

/** Imported only when the process runs with APP_ROLE=worker or all. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, WorkflowVersion]),
    QueueModule,
    ExecutionsModule,
    CredentialsModule,
    BinaryDataModule,
  ],
  providers: [ExecutionExecutor, ExecutionPruner, WorkflowProcessor],
})
export class WorkerModule {}
