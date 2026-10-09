import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import type { Page } from '../../common/pagination.js';
import type { BinaryRef, JsonObject } from '../../engine/types.js';
import { JOB_RUN, type RunJobData, WORKFLOW_QUEUE } from '../../queue/queue.js';
import { ExecutionEventsService } from '../events/execution-events.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { ExecutionStep } from './execution-step.entity.js';
import {
  Execution,
  type ExecutionMode,
  isFinished,
} from './execution.entity.js';
import type {
  ExecutionDto,
  ExecutionStepDto,
  ExecutionSummaryDto,
  ListExecutionsQuery,
} from './executions.dto.js';

const CANCEL_WAIT_MS = 10_000;

export interface StartExecutionOptions {
  mode: ExecutionMode;
  startNodeId?: string;
  /** JSON objects for the trigger node; each becomes one item. */
  input?: JsonObject[];
  /** Files for the trigger items, by index (e.g. webhook uploads). */
  binary?: Record<string, BinaryRef>[];
  /** false: the caller runs it itself (scheduled triggers already are on a worker). */
  enqueue?: boolean;
}

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);

  constructor(
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
    @InjectRepository(ExecutionStep)
    private readonly steps: Repository<ExecutionStep>,
    @InjectQueue(WORKFLOW_QUEUE) private readonly queue: Queue,
    private readonly workflows: WorkflowsService,
    private readonly events: ExecutionEventsService,
  ) {}

  /** Creates a queued execution of the workflow's current version. */
  async start(
    workspaceId: string,
    workflowId: string,
    options: StartExecutionOptions,
  ): Promise<Execution> {
    const { workflow, version } = await this.workflows.getForRun(
      workspaceId,
      workflowId,
    );
    const execution = await this.executions.save(
      this.executions.create({
        workspaceId: workflow.workspaceId,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        status: 'queued',
        mode: options.mode,
        startNodeId: options.startNodeId ?? null,
        input:
          options.input?.map((json, i) => {
            const binary = options.binary?.[i];
            return binary ? { json, binary } : { json };
          }) ?? null,
        error: null,
        startedAt: null,
        finishedAt: null,
      }),
    );
    await this.events.publish({
      type: 'execution.queued',
      executionId: execution.id,
      workflowId: workflow.id,
      mode: execution.mode,
      createdAt: execution.createdAt.toISOString(),
    });

    if (options.enqueue !== false) {
      try {
        const data: RunJobData = { executionId: execution.id };
        await this.queue.add(JOB_RUN, data, { jobId: execution.id });
      } catch (err) {
        this.logger.error(`Failed to enqueue execution ${execution.id}`, err);
        await this.executions.update(execution.id, {
          status: 'error',
          error: { name: 'QueueError', message: 'Failed to enqueue execution' },
          finishedAt: new Date(),
        });
        throw new ServiceUnavailableException('Execution queue is unavailable');
      }
    }
    return execution;
  }

  /**
   * Waits until the execution finishes or `timeoutMs` passes, then returns its
   * current state (which may still be queued/running after a timeout).
   */
  async waitForFinish(
    workspaceId: string,
    id: string,
    timeoutMs: number,
  ): Promise<ExecutionDto> {
    let unsubscribe: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const finished = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        // Subscribe before reading the status so the finish event cannot slip between.
        void this.events
          .subscribe((event) => {
            if (event.type === 'execution.finished' && event.executionId === id)
              resolve();
          })
          .then(async (off) => {
            unsubscribe = off;
            const current = await this.executions.findOneBy({ id });
            if (!current || isFinished(current.status)) resolve();
          })
          .catch((err: unknown) => {
            this.logger.warn(`Cannot wait for execution ${id}: ${String(err)}`);
            resolve();
          });
      });
      await finished;
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
    return this.get(workspaceId, id);
  }

  /**
   * Queued runs are canceled directly; running ones get a cancel request over
   * Redis that the worker holding them acts on. Waits briefly for the result.
   */
  async cancel(workspaceId: string, id: string): Promise<ExecutionDto> {
    const execution = await this.executions.findOneBy({
      id,
      workspaceId,
    });
    if (!execution) throw new NotFoundException(`Execution ${id} not found`);
    if (isFinished(execution.status)) {
      throw new ConflictException(
        `Execution already finished (${execution.status})`,
      );
    }

    const finishedAt = new Date();
    const error = {
      name: 'ExecutionCanceledError',
      message: 'Execution was canceled',
    };
    const dequeued = await this.executions.update(
      { id, status: 'queued' },
      { status: 'canceled', error, finishedAt },
    );
    if (dequeued.affected) {
      await this.queue.remove(id).catch(() => undefined);
      await this.events.publish({
        type: 'execution.finished',
        executionId: id,
        workflowId: execution.workflowId,
        status: 'canceled',
        error,
        finishedAt: finishedAt.toISOString(),
      });
      return this.get(workspaceId, id);
    }
    await this.events.requestCancel(id);
    return this.waitForFinish(workspaceId, id, CANCEL_WAIT_MS);
  }

  async list(
    workspaceId: string,
    query: ListExecutionsQuery,
  ): Promise<Page<ExecutionSummaryDto>> {
    const [items, total] = await this.executions.findAndCount({
      where: {
        workspaceId,
        ...(query.workflowId && { workflowId: query.workflowId }),
        ...(query.status && { status: query.status }),
      },
      order: { createdAt: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });
    return { items: items.map(toSummary), total };
  }

  async get(workspaceId: string, id: string): Promise<ExecutionDto> {
    const execution = await this.executions.findOneBy({
      id,
      workspaceId,
    });
    if (!execution) throw new NotFoundException(`Execution ${id} not found`);
    const steps = await this.steps.find({
      where: { executionId: id },
      order: { stepIndex: 'ASC' },
    });
    return { ...toSummary(execution), steps: steps.map(toStepDto) };
  }
}

export function toSummary(e: Execution): ExecutionSummaryDto {
  return {
    id: e.id,
    workflowId: e.workflowId,
    workflowVersionId: e.workflowVersionId,
    status: e.status,
    mode: e.mode,
    error: e.error,
    createdAt: e.createdAt,
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
  };
}

function toStepDto(s: ExecutionStep): ExecutionStepDto {
  return {
    nodeId: s.nodeId,
    nodeName: s.nodeName,
    status: s.status,
    output: s.output,
    error: s.error,
    tries: s.tries,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
  };
}
