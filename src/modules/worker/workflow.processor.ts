import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { Env } from '../../config/env.js';
import {
  BINARY_CLEANUP_SCHEDULER,
  EXECUTION_PRUNE_SCHEDULER,
  JOB_BINARY_CLEANUP,
  JOB_EXECUTION_PRUNE,
  JOB_RUN,
  JOB_SCHEDULED_TRIGGER,
  type RunJobData,
  type ScheduledTriggerJobData,
  WORKFLOW_QUEUE,
} from '../../queue/queue.js';
import { BinaryDataService } from '../binary-data/binary-data.service.js';
import { ExecutionExecutor } from './execution-executor.service.js';
import { ExecutionPruner } from './execution-pruner.service.js';

// maxStalledCount 0: a job whose worker died is failed instead of re-run,
// because re-running nodes with side effects is worse than reporting an error.
@Processor(WORKFLOW_QUEUE, { maxStalledCount: 0 })
export class WorkflowProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(WorkflowProcessor.name);

  constructor(
    private readonly executor: ExecutionExecutor,
    private readonly binaryData: BinaryDataService,
    private readonly pruner: ExecutionPruner,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(WORKFLOW_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      BINARY_CLEANUP_SCHEDULER,
      { every: 60 * 60 * 1000 },
      { name: JOB_BINARY_CLEANUP },
    );
    await this.queue.upsertJobScheduler(
      EXECUTION_PRUNE_SCHEDULER,
      { every: 60 * 60 * 1000 },
      { name: JOB_EXECUTION_PRUNE },
    );
    this.worker.concurrency = this.config.get('WORKER_CONCURRENCY', {
      infer: true,
    });
    this.logger.log(`Worker started, concurrency ${this.worker.concurrency}`);
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case JOB_RUN:
        return this.executor.execute((job.data as RunJobData).executionId);
      case JOB_SCHEDULED_TRIGGER:
        return this.executor.runScheduled(job.data as ScheduledTriggerJobData);
      case JOB_EXECUTION_PRUNE: {
        const deleted = await this.pruner.prune();
        if (deleted > 0) this.logger.log(`Pruned ${deleted} old executions`);
        return;
      }
      case JOB_BINARY_CLEANUP: {
        const removed = await this.binaryData.deleteOrphans();
        if (removed > 0) this.logger.log(`Deleted ${removed} orphaned files`);
        return;
      }
      default:
        throw new Error(`Unknown job "${job.name}"`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    this.logger.error(`Job ${job?.name}:${job?.id} failed: ${error.message}`);
    if (job?.name === JOB_RUN) {
      await this.executor.markFailed(
        (job.data as RunJobData).executionId,
        error.message,
      );
    }
  }
}
