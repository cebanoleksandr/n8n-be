import type { SerializedError } from '../../engine/workflow-runner.js';
import type {
  ExecutionMode,
  ExecutionStatus,
} from '../executions/execution.entity.js';

interface Base {
  executionId: string;
  workflowId: string;
}

/**
 * Progress events published by workers over Redis pub/sub and relayed to
 * browsers. Node output is not included; clients fetch the execution for it.
 */
export type ExecutionEvent =
  | (Base & {
      type: 'execution.queued';
      mode: ExecutionMode;
      createdAt: string;
    })
  | (Base & { type: 'execution.started'; startedAt: string })
  | (Base & { type: 'execution.waiting'; waitTill: string })
  | (Base & {
      /** From Respond to Webhook; the API answers the waiting HTTP request. */
      type: 'execution.response';
      statusCode: number;
      headers: Record<string, string>;
      body?: unknown;
      binary?: {
        id: string;
        fileName?: string;
        mimeType: string;
        size: number;
      };
    })
  | (Base & { type: 'node.started'; nodeId: string })
  | (Base & {
      type: 'node.finished';
      nodeId: string;
      nodeName: string;
      status: 'success' | 'error';
      error: SerializedError | null;
      /** Number of items on each output. */
      itemCounts: number[];
    })
  | (Base & {
      type: 'execution.finished';
      status: ExecutionStatus;
      error: (SerializedError & { nodeId?: string }) | null;
      finishedAt: string;
    });
