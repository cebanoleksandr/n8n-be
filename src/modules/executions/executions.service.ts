import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Page } from '../../common/pagination.js';
import { WorkflowValidationError } from '../../engine/errors.js';
import type { JsonObject } from '../../engine/types.js';
import {
  type RunResult,
  WorkflowRunner,
} from '../../engine/workflow-runner.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/default-workspace.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { ExecutionStep } from './execution-step.entity.js';
import { Execution } from './execution.entity.js';
import type {
  ExecutionDto,
  ExecutionStepDto,
  ExecutionSummaryDto,
  ListExecutionsQuery,
  RunWorkflowDto,
} from './executions.dto.js';

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);
  private readonly workspaceId = DEFAULT_WORKSPACE_ID;

  constructor(
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
    @InjectRepository(ExecutionStep)
    private readonly steps: Repository<ExecutionStep>,
    private readonly workflows: WorkflowsService,
    private readonly runner: WorkflowRunner,
  ) {}

  /**
   * Runs the current version in-process and waits for it to finish.
   * Moves to a BullMQ worker in v0.2; the persisted shape stays the same.
   */
  async run(workflowId: string, dto: RunWorkflowDto): Promise<ExecutionDto> {
    const { workflow, version } = await this.workflows.getForRun(workflowId);
    const execution = await this.executions.save(
      this.executions.create({
        workspaceId: this.workspaceId,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        status: 'running',
        mode: 'manual',
        error: null,
        startedAt: new Date(),
        finishedAt: null,
      }),
    );

    let stepIndex = 0;
    let result: RunResult;
    try {
      result = await this.runner.run({
        graph: version.graph,
        startNodeId: dto.startNodeId,
        triggerItems: dto.input?.map((json) => ({ json: json as JsonObject })),
        hooks: {
          nodeFinished: async (r) => {
            await this.steps.save(
              this.steps.create({
                executionId: execution.id,
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
          },
        },
      });
    } catch (err) {
      if (!(err instanceof WorkflowValidationError)) {
        this.logger.error(
          `Execution ${execution.id} crashed`,
          err instanceof Error ? err.stack : err,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      result = {
        status: 'error',
        nodes: [],
        error: { name: (err as Error)?.name ?? 'Error', message },
      };
    }

    execution.status = result.status;
    execution.error = result.error ?? null;
    execution.finishedAt = new Date();
    await this.executions.save(execution);
    return this.get(execution.id);
  }

  async list(query: ListExecutionsQuery): Promise<Page<ExecutionSummaryDto>> {
    const [items, total] = await this.executions.findAndCount({
      where: {
        workspaceId: this.workspaceId,
        ...(query.workflowId && { workflowId: query.workflowId }),
        ...(query.status && { status: query.status }),
      },
      order: { startedAt: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });
    return { items: items.map(toSummary), total };
  }

  async get(id: string): Promise<ExecutionDto> {
    const execution = await this.executions.findOneBy({
      id,
      workspaceId: this.workspaceId,
    });
    if (!execution) throw new NotFoundException(`Execution ${id} not found`);
    const steps = await this.steps.find({
      where: { executionId: id },
      order: { stepIndex: 'ASC' },
    });
    return { ...toSummary(execution), steps: steps.map(toStepDto) };
  }
}

function toSummary(e: Execution): ExecutionSummaryDto {
  return {
    id: e.id,
    workflowId: e.workflowId,
    workflowVersionId: e.workflowVersionId,
    status: e.status,
    mode: e.mode,
    error: e.error,
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
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
  };
}
