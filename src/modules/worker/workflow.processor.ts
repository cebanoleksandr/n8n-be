import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { Env } from '../../config/env.js';
import {
  JOB_RUN,
  JOB_SCHEDULED_TRIGGER,
  type RunJobData,
  type ScheduledTriggerJobData,
  WORKFLOW_QUEUE,
} from '../../queue/queue.js';
import { ExecutionExecutor } from './execution-executor.service.js';

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
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
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
