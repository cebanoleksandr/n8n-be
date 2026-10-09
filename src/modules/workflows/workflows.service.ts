import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { isDeepStrictEqual } from 'node:util';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { EMPTY_GRAPH, validateGraph } from '../../engine/graph.js';
import { NodeRegistry } from '../../engine/node-registry.js';
import type { WorkflowGraph } from '../../engine/types.js';
import type { Page, Pagination } from '../../common/pagination.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/default-workspace.js';
import { WorkflowVersion } from './workflow-version.entity.js';
import { Workflow } from './workflow.entity.js';
import type {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  WorkflowDto,
  WorkflowSummaryDto,
  WorkflowVersionDto,
} from './workflows.dto.js';

@Injectable()
export class WorkflowsService {
  // TODO: take the workspace from the authenticated user once auth exists.
  private readonly workspaceId = DEFAULT_WORKSPACE_ID;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Workflow)
    private readonly workflows: Repository<Workflow>,
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
    private readonly registry: NodeRegistry,
    private readonly triggers: TriggersService,
  ) {}

  async list({ limit, offset }: Pagination): Promise<Page<WorkflowSummaryDto>> {
    const [items, total] = await this.workflows.findAndCount({
      where: { workspaceId: this.workspaceId },
      order: { updatedAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items: items.map(toSummary), total };
  }

  async get(id: string): Promise<WorkflowDto> {
    const workflow = await this.findOrFail(id);
    const version = await this.currentVersion(workflow);
    return toDto(workflow, version);
  }

  async create(dto: CreateWorkflowDto): Promise<WorkflowDto> {
    const graph = dto.graph ?? EMPTY_GRAPH;
    this.assertValid(graph);
    return this.dataSource.transaction(async (em) => {
      const workflow = await em.save(
        em.create(Workflow, {
          workspaceId: this.workspaceId,
          name: dto.name,
          active: false,
        }),
      );
      const version = await this.addVersion(em, workflow, 1, graph);
      return toDto(workflow, version);
    });
  }

  async update(id: string, dto: UpdateWorkflowDto): Promise<WorkflowDto> {
    if (dto.graph) this.assertValid(dto.graph);
    return this.dataSource.transaction(async (em) => {
      // Lock the row so concurrent saves cannot claim the same version number.
      const workflow = await em.findOne(Workflow, {
        where: { id, workspaceId: this.workspaceId },
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

  async remove(id: string): Promise<void> {
    const result = await this.workflows.delete({
      id,
      workspaceId: this.workspaceId,
    });
    if (!result.affected)
      throw new NotFoundException(`Workflow ${id} not found`);
    await this.triggers.removeSchedulers(id);
  }

  async listVersions(id: string): Promise<WorkflowVersionDto[]> {
    await this.findOrFail(id);
    return this.versions.find({
      select: { id: true, version: true, createdAt: true },
      where: { workflowId: id },
      order: { version: 'DESC' },
    });
  }

  /** Used by executions: the workflow and the version to run. */
  async getForRun(
    id: string,
  ): Promise<{ workflow: Workflow; version: WorkflowVersion }> {
    const workflow = await this.findOrFail(id);
    return { workflow, version: await this.currentVersion(workflow) };
  }

  private async findOrFail(id: string): Promise<Workflow> {
    const workflow = await this.workflows.findOneBy({
      id,
      workspaceId: this.workspaceId,
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
    versionId: v.id,
    version: v.version,
    graph: v.graph,
  };
}
