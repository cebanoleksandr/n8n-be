import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { type EntityManager, In, Not, Repository } from 'typeorm';
import type { GraphIssue } from '../../engine/errors.js';
import type { WorkflowGraph, WorkflowNode } from '../../engine/types.js';
import { validateCron } from '../../nodes/core/schedule.node.js';
import {
  normalizeWebhookPath,
  type WebhookMethod,
  type WebhookResponseMode,
} from '../../nodes/core/webhook.node.js';
import {
  JOB_SCHEDULED_TRIGGER,
  schedulerId,
  schedulerPrefix,
  type ScheduledTriggerJobData,
  WORKFLOW_QUEUE,
} from '../../queue/queue.js';
import { WorkflowVersion } from '../workflows/workflow-version.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';
import { Webhook } from './webhook.entity.js';

interface WebhookTrigger {
  nodeId: string;
  method: WebhookMethod;
  path: string;
  responseMode: WebhookResponseMode;
}

interface ScheduleTrigger {
  nodeId: string;
  cron: string;
  timezone: string;
}

/**
 * Keeps live triggers in sync with active workflows:
 * webhooks live in the `webhooks` table (transactional with the workflow save),
 * schedules are BullMQ job schedulers in Redis (reconciled on startup).
 */
@Injectable()
export class TriggersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TriggersService.name);

  constructor(
    @InjectQueue(WORKFLOW_QUEUE) private readonly queue: Queue,
    @InjectRepository(Webhook) private readonly webhooks: Repository<Webhook>,
    @InjectRepository(Workflow)
    private readonly workflows: Repository<Workflow>,
    @InjectRepository(WorkflowVersion)
    private readonly versions: Repository<WorkflowVersion>,
  ) {}

  /**
   * Called inside the transaction that saves the workflow. Throws (and so rolls
   * the save back) when an active workflow has invalid or conflicting triggers.
   */
  async sync(
    em: EntityManager,
    workflow: Workflow,
    graph: WorkflowGraph,
  ): Promise<void> {
    await em.delete(Webhook, { workflowId: workflow.id });
    if (!workflow.active) {
      await this.syncSchedulers(workflow.id, []);
      return;
    }

    const { webhooks, schedules } = collectTriggers(graph);
    if (webhooks.length === 0 && schedules.length === 0) {
      throw new BadRequestException(
        'Workflow has no trigger that can be activated: add a Webhook or Schedule node',
      );
    }

    if (webhooks.length > 0) {
      const taken = await em.find(Webhook, {
        where: webhooks.map((w) => ({
          method: w.method,
          path: w.path,
          workflowId: Not(workflow.id),
        })),
      });
      if (taken.length > 0) {
        throw new ConflictException({
          message: 'Webhook path is already used by another active workflow',
          webhooks: taken.map((t) => `${t.method} /webhook/${t.path}`),
        });
      }
      await em.insert(
        Webhook,
        webhooks.map((w) => ({ ...w, workflowId: workflow.id })),
      );
    }
    await this.syncSchedulers(workflow.id, schedules);
  }

  /** Webhook rows go away with the workflow (FK cascade); schedulers do not. */
  async removeSchedulers(workflowId: string): Promise<void> {
    await this.syncSchedulers(workflowId, []);
  }

  findWebhook(method: string, path: string): Promise<Webhook | null> {
    return this.webhooks.findOne({
      relations: { workflow: true },
      where: { method: method.toUpperCase() as WebhookMethod, path },
    });
  }

  /** Redis and Postgres can drift (crash between writes, Redis flush): fix on startup. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcileSchedulers();
    } catch (err) {
      this.logger.error(
        `Scheduler reconciliation failed: ${(err as Error).message}`,
      );
    }
  }

  async reconcileSchedulers(): Promise<void> {
    const active = await this.workflows.find({
      select: { id: true, currentVersionId: true },
      where: { active: true },
    });
    const versionIds = active
      .map((w) => w.currentVersionId)
      .filter((id) => id !== null);
    const versions = versionIds.length
      ? await this.versions.findBy({ id: In(versionIds) })
      : [];

    const desired = new Map<
      string,
      { workflowId: string; trigger: ScheduleTrigger }
    >();
    for (const version of versions) {
      for (const trigger of collectTriggers(version.graph, false).schedules) {
        desired.set(schedulerId(version.workflowId, trigger.nodeId), {
          workflowId: version.workflowId,
          trigger,
        });
      }
    }

    let removed = 0;
    for (const id of await this.existingSchedulerIds(schedulerPrefix())) {
      if (!desired.has(id)) {
        await this.queue.removeJobScheduler(id);
        removed++;
      }
    }
    for (const { workflowId, trigger } of desired.values()) {
      await this.upsertScheduler(workflowId, trigger);
    }
    this.logger.log(
      `Schedulers reconciled: ${desired.size} active, ${removed} removed`,
    );
  }

  private async syncSchedulers(
    workflowId: string,
    schedules: ScheduleTrigger[],
  ) {
    const wanted = new Set(
      schedules.map((s) => schedulerId(workflowId, s.nodeId)),
    );
    for (const id of await this.existingSchedulerIds(
      schedulerPrefix(workflowId),
    )) {
      if (!wanted.has(id)) await this.queue.removeJobScheduler(id);
    }
    for (const s of schedules) await this.upsertScheduler(workflowId, s);
  }

  private async upsertScheduler(
    workflowId: string,
    s: ScheduleTrigger,
  ): Promise<void> {
    const data: ScheduledTriggerJobData = { workflowId, nodeId: s.nodeId };
    await this.queue.upsertJobScheduler(
      schedulerId(workflowId, s.nodeId),
      { pattern: s.cron, tz: s.timezone },
      { name: JOB_SCHEDULED_TRIGGER, data },
    );
  }

  private async existingSchedulerIds(prefix: string): Promise<string[]> {
    const schedulers = await this.queue.getJobSchedulers(0, -1);
    return schedulers.map((s) => s.key).filter((key) => key.startsWith(prefix));
  }
}

/**
 * Extracts enabled Webhook and Schedule nodes. With `strict`, invalid
 * parameters throw a 400; otherwise (reconciliation) invalid nodes are skipped.
 */
function collectTriggers(
  graph: WorkflowGraph,
  strict = true,
): { webhooks: WebhookTrigger[]; schedules: ScheduleTrigger[] } {
  const issues: GraphIssue[] = [];
  const webhooks: WebhookTrigger[] = [];
  const schedules: ScheduleTrigger[] = [];
  const seenRoutes = new Set<string>();
  const param = (n: WorkflowNode, name: string, fallback: string) => {
    const value = n.parameters[name];
    return typeof value === 'string' && value !== '' ? value : fallback;
  };

  for (const node of graph.nodes) {
    if (node.disabled) continue;
    if (node.type === 'core.webhook') {
      const path = normalizeWebhookPath(param(node, 'path', ''));
      const method = param(node, 'method', 'POST') as WebhookMethod;
      const route = `${method} ${path}`;
      if (!path) {
        issues.push({
          nodeId: node.id,
          message: `"${node.name}": invalid webhook path`,
        });
      } else if (seenRoutes.has(route)) {
        issues.push({
          nodeId: node.id,
          message: `"${node.name}": duplicate webhook ${route}`,
        });
      } else {
        seenRoutes.add(route);
        webhooks.push({
          nodeId: node.id,
          method,
          path,
          responseMode: param(
            node,
            'responseMode',
            'onReceived',
          ) as WebhookResponseMode,
        });
      }
    } else if (node.type === 'core.schedule') {
      const cron = param(node, 'cron', '0 * * * *');
      const timezone = param(node, 'timezone', 'UTC');
      const error = validateCron(cron, timezone);
      if (error)
        issues.push({ nodeId: node.id, message: `"${node.name}": ${error}` });
      else schedules.push({ nodeId: node.id, cron, timezone });
    }
  }

  if (strict && issues.length > 0) {
    throw new BadRequestException({
      message: 'Invalid trigger configuration',
      issues,
    });
  }
  return { webhooks, schedules };
}
