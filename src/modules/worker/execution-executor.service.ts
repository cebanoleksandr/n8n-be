import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { In, Repository } from 'typeorm';
import type { Env } from '../../config/env.js';
import { WorkflowValidationError } from '../../engine/errors.js';
import type { Item, JsonObject } from '../../engine/types.js';
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
import { BinaryDataService } from '../binary-data/binary-data.service.js';
import { CredentialsService } from '../credentials/credentials.service.js';
import { ExecutionEventsService } from '../events/execution-events.service.js';
import { ExecutionStep } from '../executions/execution-step.entity.js';
import { Execution } from '../executions/execution.entity.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { WorkflowVersion } from '../workflows/workflow-version.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';

/** Abort reasons, so the result can tell a timeout from a user cancel. */
class ExecutionTimeoutError extends Error {
  override name = 'ExecutionTimeoutError';
}
class ExecutionCanceledError extends Error {
  override name = 'ExecutionCanceledError';
}

type ExecutionError = NonNullable<Execution['error']>;

@Injectable()
export class ExecutionExecutor
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExecutionExecutor.name);
  /** Executions running on this worker, so cancel requests can reach them. */
  private readonly running = new Map<string, AbortController>();
  private stopListening?: () => void;

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
    private readonly binaryData: BinaryDataService,
    private readonly events: ExecutionEventsService,
    private readonly executionsService: ExecutionsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.stopListening = await this.events.onCancelRequest((executionId) => {
      this.running
        .get(executionId)
        ?.abort(new ExecutionCanceledError('Execution was canceled'));
    });
  }

  onModuleDestroy(): void {
    this.stopListening?.();
    for (const controller of this.running.values()) {
      controller.abort(new ExecutionCanceledError('Worker is shutting down'));
    }
  }

  async execute(executionId: string): Promise<void> {
    // Claim atomically: a duplicate job (or a canceled queued run) must not run.
    const startedAt = new Date();
    const claim = await this.executions.update(
      { id: executionId, status: 'queued' },
      { status: 'running', startedAt },
    );
    if (!claim.affected) {
      this.logger.warn(
        `Execution ${executionId} is missing, canceled or already claimed`,
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

    const controller = new AbortController();
    this.running.set(executionId, controller);
    let timer: NodeJS.Timeout | undefined;
    let result: RunResult;
    let workflow: Workflow | null = null;
    try {
      workflow = await this.workflows.findOneByOrFail({
        id: execution.workflowId,
      });
      const timeoutSeconds = this.timeoutSeconds(workflow);
      timer = setTimeout(
        () =>
          controller.abort(
            new ExecutionTimeoutError(
              `Execution timed out after ${timeoutSeconds}s`,
            ),
          ),
        timeoutSeconds * 1000,
      );
      const version = await this.versions.findOneByOrFail({
        id: execution.workflowVersionId,
      });
      let stepIndex = 0;
      result = await this.runner.run({
        graph: version.graph,
        startNodeId: execution.startNodeId ?? undefined,
        triggerItems: (execution.input as Item[] | null) ?? undefined,
        signal: controller.signal,
        credentials: this.credentials.providerFor(execution.workspaceId),
        binary: this.binaryData.storeFor({
          workspaceId: execution.workspaceId,
          workflowId: execution.workflowId,
          executionId,
        }),
        workflow: { id: workflow.id, name: workflow.name },
        execution: { id: executionId, mode: execution.mode },
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
                tries: r.tries,
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
    } finally {
      clearTimeout(timer);
      this.running.delete(executionId);
    }

    const { status, error } = this.outcome(result, controller.signal);
    await this.finish(execution, status, error);
    if (status === 'error' && workflow) {
      await this.startErrorWorkflow(execution, workflow, result, error!);
    }
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

  private timeoutSeconds(workflow: Workflow): number {
    const max = this.config.get('EXECUTION_TIMEOUT_MAX_SECONDS', {
      infer: true,
    });
    return Math.min(workflow.settings?.timeoutSeconds ?? max, max);
  }

  /** Maps the runner result and abort reason to the stored status. */
  private outcome(
    result: RunResult,
    signal: AbortSignal,
  ): { status: Execution['status']; error: Execution['error'] } {
    if (result.status !== 'canceled') {
      return { status: result.status, error: result.error ?? null };
    }
    const reason = signal.reason as unknown;
    const lastNodeId = result.nodes.at(-1)?.nodeId;
    if (reason instanceof ExecutionTimeoutError) {
      return {
        status: 'error',
        error: {
          name: reason.name,
          message: reason.message,
          nodeId: lastNodeId,
        },
      };
    }
    const message =
      reason instanceof Error ? reason.message : 'Execution was canceled';
    return {
      status: 'canceled',
      error: { name: 'ExecutionCanceledError', message },
    };
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

  /**
   * Like n8n: only production runs (not manual ones) trigger the error
   * workflow, and failures of error workflows themselves never chain.
   */
  private async startErrorWorkflow(
    execution: Execution,
    workflow: Workflow,
    result: RunResult,
    error: ExecutionError,
  ): Promise<void> {
    const errorWorkflowId = workflow.settings?.errorWorkflowId;
    if (
      !errorWorkflowId ||
      execution.mode === 'manual' ||
      execution.mode === 'error'
    ) {
      return;
    }
    try {
      const target = await this.workflows.findOneBy({ id: errorWorkflowId });
      const graph = target?.currentVersionId
        ? (await this.versions.findOneBy({ id: target.currentVersionId }))
            ?.graph
        : undefined;
      const trigger = graph?.nodes.find(
        (n) => n.type === 'core.errorTrigger' && !n.disabled,
      );
      if (!trigger) {
        this.logger.warn(
          `Error workflow ${errorWorkflowId} of ${workflow.id} is missing or has no Error Trigger`,
        );
        return;
      }
      const lastNode = result.nodes.at(-1);
      const payload = {
        execution: {
          id: execution.id,
          mode: execution.mode,
          error,
          lastNodeExecuted: lastNode?.nodeName ?? null,
          startedAt: execution.startedAt?.toISOString() ?? null,
        },
        workflow: { id: workflow.id, name: workflow.name },
      };
      await this.executionsService.start(errorWorkflowId, {
        mode: 'error',
        startNodeId: trigger.id,
        input: [JSON.parse(JSON.stringify(payload)) as JsonObject],
      });
    } catch (err) {
      this.logger.error(
        `Failed to start error workflow ${errorWorkflowId}`,
        err,
      );
    }
  }
}

function toError(err: unknown): SerializedError {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: 'Error', message: String(err) };
}
