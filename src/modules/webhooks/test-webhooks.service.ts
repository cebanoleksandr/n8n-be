import {
  BadRequestException,
  ConflictException,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import { redisOptionsFromUrl } from '../../redis/redis-options.js';
import { collectTriggers } from '../triggers/triggers.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import type { WebhookTarget } from './webhook-dispatcher.service.js';

/** How long the editor listens for a test request. */
export const TEST_WEBHOOK_TTL_SECONDS = 120;
const KEY_PREFIX = 'flow:test-webhook:';

export interface TestWebhookUrl {
  nodeId: string;
  method: string;
  path: string;
}

/**
 * Editor test webhooks (/webhook-test/<path>): registered in Redis for a short
 * time, consumed by the first matching request, and run as manual executions
 * of the saved workflow, active or not.
 */
@Injectable()
export class TestWebhooksService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    private readonly workflows: WorkflowsService,
    config: ConfigService<Env, true>,
  ) {
    this.redis = new Redis({
      ...redisOptionsFromUrl(config.get('REDIS_URL', { infer: true })),
      maxRetriesPerRequest: 3,
    });
  }

  async listen(
    workspaceId: string,
    workflowId: string,
    nodeId?: string,
  ): Promise<{ webhooks: TestWebhookUrl[]; expiresInSeconds: number }> {
    const { version } = await this.workflows.getForRun(workspaceId, workflowId);
    const webhooks = collectTriggers(version.graph).webhooks.filter(
      (w) => !nodeId || w.nodeId === nodeId,
    );
    if (webhooks.length === 0) {
      throw new BadRequestException(
        nodeId
          ? `Node "${nodeId}" is not an enabled Webhook node`
          : 'Workflow has no Webhook node',
      );
    }

    for (const w of webhooks) {
      const target: WebhookTarget = {
        workspaceId,
        workflowId,
        nodeId: w.nodeId,
        responseMode: w.responseMode,
      };
      const key = keyFor(w.method, w.path);
      // Refuse to take over a path another workflow is listening on.
      const current = await this.redis.get(key);
      if (
        current &&
        (JSON.parse(current) as WebhookTarget).workflowId !== workflowId
      ) {
        throw new ConflictException(
          `Another workflow is listening on ${w.method} /webhook-test/${w.path}`,
        );
      }
      await this.redis.set(
        key,
        JSON.stringify(target),
        'EX',
        TEST_WEBHOOK_TTL_SECONDS,
      );
    }
    return {
      webhooks: webhooks.map((w) => ({
        nodeId: w.nodeId,
        method: w.method,
        path: w.path,
      })),
      expiresInSeconds: TEST_WEBHOOK_TTL_SECONDS,
    };
  }

  async stop(workspaceId: string, workflowId: string): Promise<void> {
    const { version } = await this.workflows.getForRun(workspaceId, workflowId);
    for (const w of collectTriggers(version.graph, false).webhooks) {
      const key = keyFor(w.method, w.path);
      const current = await this.redis.get(key);
      if (
        current &&
        (JSON.parse(current) as WebhookTarget).workflowId === workflowId
      ) {
        await this.redis.del(key);
      }
    }
  }

  /** Single use: the registration is removed by the request that consumes it. */
  async claim(method: string, path: string): Promise<WebhookTarget | null> {
    const value = await this.redis.getdel(keyFor(method.toUpperCase(), path));
    return value ? (JSON.parse(value) as WebhookTarget) : null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}

function keyFor(method: string, path: string): string {
  return `${KEY_PREFIX}${method}:${path}`;
}
