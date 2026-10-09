import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { isDeepStrictEqual } from 'node:util';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { EMPTY_GRAPH, validateGraph } from '../../engine/graph.js';
import { NodeRegistry } from '../../engine/node-registry.js';
import type { WorkflowGraph } from '../../engine/types.js';
import type { Page, Pagination } from '../../common/pagination.js';
import type { Env } from '../../config/env.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { WorkflowVersion } from './workflow-version.entity.js';
import { Workflow, type WorkflowSettings } from './workflow.entity.js';
import type {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  WorkflowDto,
  WorkflowSummaryDto,
  WorkflowVersionDto,
} from './workflows.dto.js';

@Injectable()
export class WorkflowsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Workflow)
    private readonly workflows: Repository<Workflow>,
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
    private readonly registry: NodeRegistry,
    private readonly triggers: TriggersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(
    workspaceId: string,
    { limit, offset }: Pagination,
  ): Promise<Page<WorkflowSummaryDto>> {
    const [items, total] = await this.workflows.findAndCount({
      where: { workspaceId },
      order: { updatedAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items: items.map(toSummary), total };
  }

  async get(workspaceId: string, id: string): Promise<WorkflowDto> {
    const workflow = await this.findOrFail(workspaceId, id);
    const version = await this.currentVersion(workflow);
    return toDto(workflow, version);
  }

  async create(
    workspaceId: string,
    dto: CreateWorkflowDto,
  ): Promise<WorkflowDto> {
    const graph = dto.graph ?? EMPTY_GRAPH;
    this.assertValid(graph);
    return this.dataSource.transaction(async (em) => {
      const workflow = await em.save(
        em.create(Workflow, {
          workspaceId,
          name: dto.name,
          active: false,
          settings: {},
        }),
      );
      const version = await this.addVersion(em, workflow, 1, graph);
      return toDto(workflow, version);
    });
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateWorkflowDto,
  ): Promise<WorkflowDto> {
    if (dto.graph) this.assertValid(dto.graph);
    return this.dataSource.transaction(async (em) => {
      // Lock the row so concurrent saves cannot claim the same version number.
      const workflow = await em.findOne(Workflow, {
        where: { id, workspaceId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!workflow) throw new NotFoundException(`Workflow ${id} not found`);

      let version = await this.currentVersion(workflow, em);
      const graphChanged =
        dto.graph !== undefined && !isDeepStrictEqual(dto.graph, version.graph);
      if (graphChanged) {
        version = await this.addVersion(
          em,
          workflow,
          version.version + 1,
          dto.graph!,
        );
      }
      if (dto.name !== undefined) workflow.name = dto.name;
      if (dto.settings) {
        workflow.settings = await this.mergeSettings(
          em,
          workflow,
          dto.settings,
        );
      }
      const activeChanged =
        dto.active !== undefined && dto.active !== workflow.active;
      if (dto.active !== undefined) workflow.active = dto.active;
      await em.save(workflow);
      if (activeChanged || (graphChanged && workflow.active)) {
        await this.triggers.sync(em, workflow, version.graph);
      }
      return toDto(workflow, version);
    });
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const result = await this.workflows.delete({
      id,
      workspaceId,
    });
    if (!result.affected)
      throw new NotFoundException(`Workflow ${id} not found`);
    await this.triggers.removeSchedulers(id);
  }

  async listVersions(
    workspaceId: string,
    id: string,
  ): Promise<WorkflowVersionDto[]> {
    await this.findOrFail(workspaceId, id);
    return this.versions.find({
      select: { id: true, version: true, createdAt: true },
      where: { workflowId: id },
      order: { version: 'DESC' },
    });
  }

  /** Used by executions: the workflow and the version to run. */
  async getForRun(
    workspaceId: string,
    id: string,
  ): Promise<{ workflow: Workflow; version: WorkflowVersion }> {
    const workflow = await this.findOrFail(workspaceId, id);
    return { workflow, version: await this.currentVersion(workflow) };
  }

  private async findOrFail(workspaceId: string, id: string): Promise<Workflow> {
    const workflow = await this.workflows.findOneBy({
      id,
      workspaceId,
    });
    if (!workflow) throw new NotFoundException(`Workflow ${id} not found`);
    return workflow;
  }

  private async currentVersion(
    workflow: Workflow,
    em: EntityManager = this.dataSource.manager,
  ): Promise<WorkflowVersion> {
    return em.findOneByOrFail(WorkflowVersion, {
      id: workflow.currentVersionId!,
    });
  }

  private async addVersion(
    em: EntityManager,
    workflow: Workflow,
    number: number,
    graph: WorkflowGraph,
  ): Promise<WorkflowVersion> {
    const version = await em.save(
      em.create(WorkflowVersion, {
        workflowId: workflow.id,
        version: number,
        graph,
      }),
    );
    workflow.currentVersionId = version.id;
    await em.update(Workflow, workflow.id, { currentVersionId: version.id });
    return version;
  }

  private async mergeSettings(
    em: EntityManager,
    workflow: Workflow,
    patch: NonNullable<UpdateWorkflowDto['settings']>,
  ): Promise<WorkflowSettings> {
    const settings: WorkflowSettings = { ...workflow.settings };
    for (const key of ['errorWorkflowId', 'timeoutSeconds'] as const) {
      const value = patch[key];
      if (value === null) delete settings[key];
      else if (value !== undefined)
        (settings as Record<string, unknown>)[key] = value;
    }

    const max = this.config.get('EXECUTION_TIMEOUT_MAX_SECONDS', {
      infer: true,
    });
    if (
      settings.timeoutSeconds !== undefined &&
      settings.timeoutSeconds > max
    ) {
      throw new BadRequestException(`timeoutSeconds cannot exceed ${max}`);
    }
    if (patch.errorWorkflowId) {
      if (patch.errorWorkflowId === workflow.id) {
        throw new BadRequestException(
          'A workflow cannot be its own error workflow',
        );
      }
      const target = await em.findOneBy(Workflow, {
        id: patch.errorWorkflowId,
        workspaceId: workflow.workspaceId,
      });
      if (!target) {
        throw new BadRequestException(
          `Workflow ${patch.errorWorkflowId} not found`,
        );
      }
      const graph = (await this.currentVersion(target, em)).graph;
      if (
        !graph.nodes.some((n) => n.type === 'core.errorTrigger' && !n.disabled)
      ) {
        throw new BadRequestException(
          `Workflow "${target.name}" has no Error Trigger node`,
        );
      }
    }
    return settings;
  }

  private assertValid(graph: WorkflowGraph): void {
    const issues = validateGraph(graph, this.registry);
    if (issues.length > 0) {
      throw new BadRequestException({
        message: 'Invalid workflow graph',
        issues,
      });
    }
  }
}

function toSummary(w: Workflow): WorkflowSummaryDto {
  return {
    id: w.id,
    name: w.name,
    active: w.active,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function toDto(w: Workflow, v: WorkflowVersion): WorkflowDto {
  return {
    ...toSummary(w),
    settings: w.settings,
    versionId: v.id,
    version: v.version,
    graph: v.graph,
  };
}
