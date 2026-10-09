import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { BinaryRef, JsonObject } from '../../engine/types.js';
import type { WebhookResponseMode } from '../../nodes/core/webhook.node.js';
import { BinaryDataService } from '../binary-data/binary-data.service.js';
import type { ExecutionMode } from '../executions/execution.entity.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { receiveFiles } from './webhook-uploads.js';

/** How long a "respond when finished" webhook waits before answering 202. */
const RESPONSE_TIMEOUT_MS = 30_000;

export interface WebhookTarget {
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  responseMode: WebhookResponseMode;
}

/** Turns an incoming HTTP request into an execution and answers it. */
@Injectable()
export class WebhookDispatcher {
  constructor(
    private readonly executions: ExecutionsService,
    private readonly binaryData: BinaryDataService,
  ) {}

  async dispatch(
    req: Request,
    res: Response,
    target: WebhookTarget,
    path: string,
    mode: Extract<ExecutionMode, 'webhook' | 'manual'>,
  ): Promise<void> {
    const { workspaceId, workflowId } = target;
    // Files are stored before the execution exists and linked to it afterwards.
    const files = await receiveFiles(req, res, this.binaryData.maxBytes);
    const binary: Record<string, BinaryRef> = {};
    for (const file of files) {
      binary[file.field] = await this.binaryData.put(
        { workspaceId, workflowId },
        file.data,
        { fileName: file.fileName, mimeType: file.mimeType },
      );
    }

    const execution = await this.executions.start(workspaceId, workflowId, {
      mode,
      startNodeId: target.nodeId,
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

    if (target.responseMode !== 'lastNode') {
      res.status(202).json({ executionId: execution.id });
      return;
    }

    const result = await this.executions.waitForFinish(
      workspaceId,
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
