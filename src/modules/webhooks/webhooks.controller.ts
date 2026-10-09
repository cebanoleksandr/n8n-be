import { All, Controller, Module, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { BinaryRef, JsonObject } from '../../engine/types.js';
import { normalizeWebhookPath } from '../../nodes/core/webhook.node.js';
import { BinaryDataModule } from '../binary-data/binary-data.module.js';
import { BinaryDataService } from '../binary-data/binary-data.service.js';
import { ExecutionsModule } from '../executions/executions.module.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { TriggersService } from '../triggers/triggers.service.js';
import { receiveFiles } from './webhook-uploads.js';

/** How long a "respond when finished" webhook waits before answering 202. */
const RESPONSE_TIMEOUT_MS = 30_000;

/** Public entry point for Webhook trigger nodes: ANY /webhook/<path>. */
@ApiExcludeController()
@Controller('webhook')
export class WebhooksController {
  constructor(
    private readonly triggers: TriggersService,
    private readonly executions: ExecutionsService,
    private readonly binaryData: BinaryDataService,
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

    // Files are stored before the execution exists and linked to it afterwards.
    const files = await receiveFiles(req, res, this.binaryData.maxBytes);
    const binary: Record<string, BinaryRef> = {};
    for (const file of files) {
      binary[file.field] = await this.binaryData.put(
        {
          workspaceId: webhook.workflow!.workspaceId,
          workflowId: webhook.workflowId,
        },
        file.data,
        { fileName: file.fileName, mimeType: file.mimeType },
      );
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
      binary: files.length > 0 ? [binary] : undefined,
    });
    if (files.length > 0) {
      await this.binaryData.linkExecution(
        Object.values(binary).map((b) => b.id),
        execution.id,
      );
    }

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
  imports: [ExecutionsModule, TriggersModule, BinaryDataModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
