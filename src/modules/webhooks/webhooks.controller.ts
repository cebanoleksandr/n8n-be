import { All, Controller, Module, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { JsonObject } from '../../engine/types.js';
import { normalizeWebhookPath } from '../../nodes/core/webhook.node.js';
import { ExecutionsModule } from '../executions/executions.module.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';

/** How long a "respond when finished" webhook waits before answering 202. */
const RESPONSE_TIMEOUT_MS = 30_000;

/** Public entry point for Webhook trigger nodes: ANY /webhook/<path>. */
@ApiExcludeController()
@Controller('webhook')
export class WebhooksController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly executions: ExecutionsService,
  ) {}

  @All('*path')
  async handle(
    @Param('path') pathParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const path = normalizeWebhookPath(
      Array.isArray(pathParam) ? pathParam.join('/') : pathParam,
    );
    const webhook = path
      ? await this.triggers.findWebhook(req.method, path)
      : null;
    if (!webhook) {
      res.status(404).json({
        message: `No active webhook for ${req.method} /webhook/${path ?? ''}`,
      });
      return;
    }

    const execution = await this.executions.start(webhook.workflowId, {
      mode: 'webhook',
      startNodeId: webhook.nodeId,
      input: [
        {
          method: req.method,
          path,
          headers: req.headers as JsonObject,
          query: req.query as JsonObject,
          body: (req.body ?? null) as JsonObject,
        },
      ],
    });

    if (webhook.responseMode !== 'lastNode') {
      res.status(202).json({ executionId: execution.id });
      return;
    }

    const result = await this.executions.waitForFinish(
      execution.id,
      RESPONSE_TIMEOUT_MS,
    );
    if (result.status === 'success') {
      // First item of the last node that ran, like n8n's "Last Node" mode.
      const last = result.steps.at(-1);
      res.status(200).json(last?.output[0]?.[0]?.json ?? {});
    } else if (result.status === 'error') {
      res.status(500).json({
        message: 'Workflow execution failed',
        executionId: execution.id,
        error: result.error,
      });
    } else {
      res
        .status(202)
        .json({ executionId: execution.id, status: result.status });
    }
  }
}

@Module({
  imports: [ExecutionsModule, TriggersModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
