import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { codeSandbox } from '../../sandbox/sandbox-client.js';
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

/** Stops the Code node sandbox process with the worker. */
@Injectable()
class CodeSandboxLifecycle implements OnModuleDestroy {
  onModuleDestroy(): void {
    codeSandbox.close();
  }
}

/** Imported only when the process runs with APP_ROLE=worker or all. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Workflow, WorkflowVersion]),
    QueueModule,
    ExecutionsModule,
    CredentialsModule,
    BinaryDataModule,
  ],
  providers: [
    ExecutionExecutor,
    ExecutionPruner,
    WorkflowProcessor,
    CodeSandboxLifecycle,
  ],
})
export class WorkerModule {}
