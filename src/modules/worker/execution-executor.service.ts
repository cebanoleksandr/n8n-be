import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';
import { WorkflowValidationError } from '../../engine/errors.js';
import type { Item } from '../../engine/types.js';
import {
  type RunResult,
  type SerializedError,
  WorkflowRunner,
} from '../../engine/workflow-runner.js';
import {
  schedulerId,
  type ScheduledTriggerJobData,
  WORKFLOW_QUEUE,
} from '../../queue/queue.js';
import { CredentialsService } from '../credentials/credentials.service.js';
import { ExecutionEventsService } from '../events/execution-events.service.js';
import { ExecutionStep } from '../executions/execution-step.entity.js';
import { Execution } from '../executions/execution.entity.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { WorkflowVersion } from '../workflows/workflow-version.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';

@Injectable()
export class ExecutionExecutor {
  private readonly logger = new Logger(ExecutionExecutor.name);

  constructor(
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
    @InjectRepository(ExecutionStep)
    private readonly steps: Repository<ExecutionStep>,
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
    @InjectRepository(Workflow)
    private readonly workflows: Repository<Workflow>,
    @InjectQueue(WORKFLOW_QUEUE) private readonly queue: Queue,
    private readonly runner: WorkflowRunner,
    private readonly credentials: CredentialsService,
    private readonly events: ExecutionEventsService,
    private readonly executionsService: ExecutionsService,
  ) {}

  async execute(executionId: string): Promise<void> {
    // Claim atomically: a duplicate job must never run the same execution twice.
    const startedAt = new Date();
    const claim = await this.executions.update(
      { id: executionId, status: 'queued' },
      { status: 'running', startedAt },
    );
    if (!claim.affected) {
      this.logger.warn(
        `Execution ${executionId} is missing or already claimed`,
      );
      return;
    }
    const execution = await this.executions.findOneByOrFail({
      id: executionId,
    });
    const base = { executionId, workflowId: execution.workflowId };
    await this.events.publish({
      ...base,
      type: 'execution.started',
      startedAt: startedAt.toISOString(),
    });

    let result: RunResult;
    try {
      const version = await this.versions.findOneByOrFail({
        id: execution.workflowVersionId,
      });
      let stepIndex = 0;
      result = await this.runner.run({
        graph: version.graph,
        startNodeId: execution.startNodeId ?? undefined,
        triggerItems: (execution.input as Item[] | null) ?? undefined,
        credentials: this.credentials.providerFor(execution.workspaceId),
        hooks: {
          nodeStarted: (node) =>
            this.events.publish({
              ...base,
              type: 'node.started',
              nodeId: node.id,
            }),
          nodeFinished: async (r) => {
            await this.steps.save(
              this.steps.create({
                executionId,
                stepIndex: stepIndex++,
                nodeId: r.nodeId,
                nodeName: r.nodeName,
                status: r.status,
                output: r.output,
                error: r.error ?? null,
                startedAt: r.startedAt,
                finishedAt: r.finishedAt,
              }),
            );
            await this.events.publish({
              ...base,
              type: 'node.finished',
              nodeId: r.nodeId,
              nodeName: r.nodeName,
              status: r.status,
              error: r.error ?? null,
              itemCounts: r.output.map((items) => items.length),
            });
          },
        },
      });
    } catch (err) {
      if (!(err instanceof WorkflowValidationError)) {
        this.logger.error(`Execution ${executionId} crashed`, err);
      }
      result = { status: 'error', nodes: [], error: toError(err) };
    }
    await this.finish(execution, result.status, result.error ?? null);
  }

  /** Runs a Schedule trigger tick directly on this worker. */
  async runScheduled({
    workflowId,
    nodeId,
  }: ScheduledTriggerJobData): Promise<void> {
    const workflow = await this.workflows.findOneBy({ id: workflowId });
    const version = workflow?.currentVersionId
      ? await this.versions.findOneBy({ id: workflow.currentVersionId })
      : null;
    const node = version?.graph.nodes.find((n) => n.id === nodeId);
    if (
      !workflow?.active ||
      !node ||
      node.disabled ||
      node.type !== 'core.schedule'
    ) {
      // Stale scheduler (workflow deactivated or node removed while Redis lagged behind).
      this.logger.warn(
        `Removing stale scheduler ${schedulerId(workflowId, nodeId)}`,
      );
      await this.queue.removeJobScheduler(schedulerId(workflowId, nodeId));
      return;
    }
    const execution = await this.executionsService.start(workflowId, {
      mode: 'schedule',
      startNodeId: nodeId,
      input: [{ timestamp: new Date().toISOString() }],
      enqueue: false,
    });
    await this.execute(execution.id);
  }

  /** For jobs that failed outside the runner (stalled worker, crash). */
  async markFailed(executionId: string, message: string): Promise<void> {
    const execution = await this.executions.findOneBy({
      id: executionId,
      status: In(['queued', 'running']),
    });
    if (execution) {
      await this.finish(execution, 'error', { name: 'WorkerError', message });
    }
  }

  private async finish(
    execution: Execution,
    status: Execution['status'],
    error: Execution['error'],
  ): Promise<void> {
    const finishedAt = new Date();
    await this.executions.update(execution.id, { status, error, finishedAt });
    await this.events.publish({
      type: 'execution.finished',
      executionId: execution.id,
      workflowId: execution.workflowId,
      status,
      error,
      finishedAt: finishedAt.toISOString(),
    });
  }
}

function toError(err: unknown): SerializedError {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: 'Error', message: String(err) };
}
