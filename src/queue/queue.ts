import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

export const WORKFLOW_QUEUE = 'workflows';

/** Run an already created execution. */
export const JOB_RUN = 'run';
/** Fired by a BullMQ job scheduler for a Schedule trigger node. */
export const JOB_SCHEDULED_TRIGGER = 'scheduled-trigger';
/** Hourly: delete stored files whose workflow was deleted. */
export const JOB_BINARY_CLEANUP = 'binary-cleanup';
export const BINARY_CLEANUP_SCHEDULER = 'maintenance:binary-cleanup';
/** Hourly: delete old finished executions (EXECUTIONS_MAX_AGE_DAYS). */
export const JOB_EXECUTION_PRUNE = 'execution-prune';
export const EXECUTION_PRUNE_SCHEDULER = 'maintenance:execution-prune';

export interface RunJobData {
  executionId: string;
}

export interface ScheduledTriggerJobData {
  workflowId: string;
  nodeId: string;
}

export function schedulerId(workflowId: string, nodeId: string): string {
  return `${schedulerPrefix(workflowId)}${nodeId}`;
}

export function schedulerPrefix(workflowId?: string): string {
  return workflowId ? `schedule:${workflowId}:` : 'schedule:';
}

@Module({
  imports: [
    BullModule.registerQueue({
      name: WORKFLOW_QUEUE,
      defaultJobOptions: {
        // Never retry automatically: nodes may have side effects.
        attempts: 1,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
