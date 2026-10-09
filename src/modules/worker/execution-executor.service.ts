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
import { In, LessThan, Repository } from 'typeorm';
import type { Env } from '../../config/env.js';
import {
  NodeOperationError,
  WorkflowValidationError,
} from '../../engine/errors.js';
import type { Item, JsonObject } from '../../engine/types.js';
import {
  type RunResult,
  type RunState,
  type SerializedError,
  WorkflowRunner,
} from '../../engine/workflow-runner.js';
import {
  schedulerId,
  type ScheduledTriggerJobData,
  WORKFLOW_QUEUE,
  JOB_RESUME,
  resumeJobId,
  type RunJobData,
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

  /**
   * Runs a queued execution. `parentSignal` links a waited-for sub-workflow to
   * its caller, so canceling or timing out the caller stops it too.
   */
  async execute(
    executionId: string,
    parentSignal?: AbortSignal,
    { resume = false }: { resume?: boolean } = {},
  ): Promise<ExecutionOutcome | null> {
    // Claim atomically: a duplicate job (or a canceled run) must not run.
    // A resumed run keeps its original start time.
    const startedAt = new Date();
    const claim = await this.executions.update(
      { id: executionId, status: resume ? 'waiting' : 'queued' },
      resume ? { status: 'running' } : { status: 'running', startedAt },
    );
    if (!claim.affected) {
      this.logger.warn(
        `Execution ${executionId} is missing, canceled or already claimed`,
      );
      return null;
    }
    const execution = await this.executions.findOneByOrFail({
      id: executionId,
    });
    const base = { executionId, workflowId: execution.workflowId };
    await this.events.publish({
      ...base,
      type: 'execution.started',
      startedAt: (execution.startedAt ?? startedAt).toISOString(),
    });

    const controller = new AbortController();
    this.running.set(executionId, controller);
    const forwardAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) forwardAbort();
    parentSignal?.addEventListener('abort', forwardAbort, { once: true });
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
      let responded = false;
      // A resumed run appends to the steps recorded before the pause.
      let stepIndex = resume ? await this.steps.countBy({ executionId }) : 0;
      const runOptions = execution.runOptions ?? {};
      result = await this.runner.run({
        graph: version.graph,
        startNodeId: execution.startNodeId ?? undefined,
        destinationNodeId: runOptions.destinationNodeId,
        resume:
          resume && execution.waitState
            ? (execution.waitState as unknown as RunState)
            : undefined,
        runFrom:
          !resume && runOptions.runFromNodeId && runOptions.sourceExecutionId
            ? {
                nodeId: runOptions.runFromNodeId,
                previousOutputs: await this.previousOutputs(
                  runOptions.sourceExecutionId,
                ),
              }
            : undefined,
        // Pinned test data only applies to runs started from the editor.
        pinData:
          execution.mode === 'manual' ? toItems(workflow.pinData) : undefined,
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
        onWebhookResponse: async (response) => {
          // Only the first Respond to Webhook answers the request.
          if (responded) return;
          responded = true;
          await this.events.publish({
            ...base,
            type: 'execution.response',
            statusCode: response.statusCode,
            headers: response.headers,
            body: response.body,
            binary: response.binary,
          });
        },
        subWorkflows: {
          run: (targetId, items, wait) =>
            this.runSubWorkflow(
              execution,
              targetId,
              items,
              wait,
              controller.signal,
            ),
        },
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
                pinned: r.pinned ?? false,
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
      parentSignal?.removeEventListener('abort', forwardAbort);
    }

    if (result.status === 'waiting' && result.waitTill && result.state) {
      try {
        await this.suspend(execution, result.waitTill, result.state);
        return { status: 'waiting', error: null, lastOutput: [] };
      } catch (err) {
        // Never leave a run "waiting" without a job that will resume it.
        this.logger.error(`Could not pause execution ${executionId}`, err);
        result = { status: 'error', nodes: result.nodes, error: toError(err) };
      }
    }
    const { status, error } = this.outcome(result, controller.signal);
    await this.finish(execution, status, error);
    if (status === 'error' && workflow) {
      await this.startErrorWorkflow(execution, workflow, result, error!);
    }
    return { status, error, lastOutput: result.nodes.at(-1)?.output[0] ?? [] };
  }

  /**
   * Execute Workflow node: creates a child execution of the target's current
   * version. When waiting, it runs right here (inside the caller's job slot,
   * so nested calls cannot starve the worker pool) and returns its last output.
   */
  private async runSubWorkflow(
    parent: Execution,
    targetId: string,
    items: Item[],
    wait: boolean,
    signal: AbortSignal,
  ): Promise<Item[]> {
    if (parent.depth >= MAX_SUBWORKFLOW_DEPTH) {
      throw new NodeOperationError(
        `Sub-workflows can be nested at most ${MAX_SUBWORKFLOW_DEPTH} levels deep`,
      );
    }
    const target = await this.workflows.findOneBy({
      id: targetId,
      workspaceId: parent.workspaceId,
    });
    if (!target) throw new NodeOperationError(`Workflow ${targetId} not found`);
    const graph = target.currentVersionId
      ? (await this.versions.findOneBy({ id: target.currentVersionId }))?.graph
      : undefined;
    const trigger = graph?.nodes.find(
      (n) => n.type === 'core.executeWorkflowTrigger' && !n.disabled,
    );
    if (!trigger) {
      throw new NodeOperationError(
        `Workflow "${target.name}" has no Execute Workflow Trigger`,
      );
    }

    const child = await this.executionsService.start(
      parent.workspaceId,
      targetId,
      {
        mode: 'subworkflow',
        startNodeId: trigger.id,
        input: items.map((i) => i.json),
        binary: items.map((i) => i.binary),
        enqueue: !wait,
        parentExecutionId: parent.id,
        depth: parent.depth + 1,
      },
    );
    if (!wait) return items;

    const outcome = await this.execute(child.id, signal);
    if (outcome?.status === 'waiting') {
      throw new NodeOperationError(
        `Sub-workflow "${target.name}" paused at a Wait node; turn off "Wait for Completion" to run it in the background`,
      );
    }
    if (outcome?.status !== 'success') {
      const reason = outcome?.error?.message ?? 'did not run';
      throw new NodeOperationError(
        `Sub-workflow "${target.name}" failed: ${reason}`,
      );
    }
    return outcome.lastOutput;
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
    const execution = await this.executionsService.start(
      workflow.workspaceId,
      workflowId,
      {
        mode: 'schedule',
        startNodeId: nodeId,
        input: [{ timestamp: new Date().toISOString() }],
        enqueue: false,
      },
    );
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

  /**
   * Successful node outputs of an earlier run. When that run was itself
   * partial, its own source is included too (newer outputs win).
   */
  private async previousOutputs(
    executionId: string,
  ): Promise<Record<string, Item[][]>> {
    const chain: string[] = [];
    let next: string | undefined = executionId;
    while (next && chain.length < MAX_SOURCE_CHAIN && !chain.includes(next)) {
      chain.push(next);
      const source: Execution | null = await this.executions.findOne({
        select: { id: true, runOptions: true },
        where: { id: next },
      });
      next = source?.runOptions?.sourceExecutionId;
    }
    const outputs: Record<string, Item[][]> = {};
    for (const id of chain.reverse()) {
      const steps = await this.steps.find({
        where: { executionId: id, status: 'success' },
        order: { stepIndex: 'ASC' },
      });
      for (const step of steps) outputs[step.nodeId] = step.output as Item[][];
    }
    return outputs;
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

  /** Persists a paused run and schedules its continuation. */
  private async suspend(execution: Execution, waitTill: Date, state: RunState) {
    // Query builder: TypeORM's update() types cannot express the item JSON.
    await this.executions
      .createQueryBuilder()
      .update()
      .set({
        status: 'waiting',
        waitTill,
        waitState: () => 'CAST(:state AS jsonb)',
      })
      .setParameter('state', JSON.stringify(state))
      .where('id = :id', { id: execution.id })
      .execute();
    await this.events.publish({
      type: 'execution.waiting',
      executionId: execution.id,
      workflowId: execution.workflowId,
      waitTill: waitTill.toISOString(),
    });
    await this.scheduleResume(execution.id, waitTill);
  }

  private async scheduleResume(executionId: string, waitTill: Date) {
    const data: RunJobData = { executionId };
    await this.queue.add(JOB_RESUME, data, {
      jobId: resumeJobId(executionId),
      delay: Math.max(0, waitTill.getTime() - Date.now()),
    });
  }

  /**
   * Waiting runs whose resume job is gone (e.g. Redis was flushed) and that
   * are overdue get a new one. Job ids are deterministic, so this is idempotent.
   */
  async recoverOverdueWaits(): Promise<number> {
    const overdue = await this.executions.find({
      select: { id: true, waitTill: true },
      where: {
        status: 'waiting',
        waitTill: LessThan(new Date(Date.now() - RESUME_GRACE_MS)),
      },
      take: 1000,
    });
    for (const e of overdue) await this.scheduleResume(e.id, e.waitTill!);
    return overdue.length;
  }

  private async finish(
    execution: Execution,
    status: Execution['status'],
    error: Execution['error'],
  ): Promise<void> {
    const finishedAt = new Date();
    await this.executions.update(execution.id, {
      status,
      error,
      finishedAt,
      waitTill: null,
      waitState: null,
    });
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
      execution.mode === 'error' ||
      // The calling workflow fails too and reports it.
      execution.mode === 'subworkflow'
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
      await this.executionsService.start(
        workflow.workspaceId,
        errorWorkflowId,
        {
          mode: 'error',
          startNodeId: trigger.id,
          input: [JSON.parse(JSON.stringify(payload)) as JsonObject],
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to start error workflow ${errorWorkflowId}`,
        err,
      );
    }
  }
}

const MAX_SOURCE_CHAIN = 20;
const MAX_SUBWORKFLOW_DEPTH = 10;
/** Resume jobs normally fire on time; only re-schedule clearly overdue ones. */
const RESUME_GRACE_MS = 60_000;

export interface ExecutionOutcome {
  status: Execution['status'];
  error: Execution['error'];
  /** First output of the last executed node (the result of a sub-workflow). */
  lastOutput: Item[];
}

function toItems(
  pinData: Record<string, Record<string, unknown>[]> | undefined,
): Record<string, Item[]> | undefined {
  if (!pinData || Object.keys(pinData).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(pinData).map(([nodeId, items]) => [
      nodeId,
      items.map((json) => ({ json: json as JsonObject })),
    ]),
  );
}

function toError(err: unknown): SerializedError {
  return err instanceof Error
    ? { name: err.name, message: err.message }
    : { name: 'Error', message: String(err) };
}
