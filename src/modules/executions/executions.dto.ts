import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { paginationSchema } from '../../common/pagination.js';
import type { JsonObject } from '../../engine/types.js';
import type { StoredItem } from './execution-step.entity.js';
import {
  EXECUTION_MODES,
  EXECUTION_STATUSES,
  type ExecutionMode,
  type ExecutionStatus,
} from './execution.entity.js';

const STATUSES = EXECUTION_STATUSES;

export const runWorkflowSchema = z
  .object({
    startNodeId: z.string().optional(),
    /** JSON objects handed to the trigger node as items. */
    input: z.array(z.record(z.string(), z.unknown())).optional(),
    destinationNodeId: z.string().optional(),
    runFromNodeId: z.string().optional(),
    sourceExecutionId: z.uuid().optional(),
  })
  .refine(
    (v) => !(v.runFromNodeId && v.startNodeId),
    'Use either startNodeId (a trigger) or runFromNodeId',
  );

export class RunWorkflowDto {
  @ApiPropertyOptional({
    description: 'Trigger node to start from. Defaults to the first trigger',
  })
  startNodeId?: string;

  @ApiPropertyOptional({
    description:
      'Items for the trigger node; each object becomes { json: object }',
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [{ name: 'Ann' }],
  })
  input?: JsonObject[];

  @ApiPropertyOptional({
    description: 'Run only this node and the nodes it depends on',
  })
  destinationNodeId?: string;

  @ApiPropertyOptional({
    description:
      'Re-run from this node, feeding it the outputs of an earlier run (pinned data applies)',
  })
  runFromNodeId?: string;

  @ApiPropertyOptional({
    description:
      'Earlier execution whose outputs feed runFromNodeId. Defaults to the latest finished one',
  })
  sourceExecutionId?: string;
}

export const runQuerySchema = z.object({
  wait: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const listExecutionsSchema = paginationSchema.extend({
  workflowId: z.uuid().optional(),
  status: z.enum(STATUSES).optional(),
});

export class ListExecutionsQuery {
  @ApiPropertyOptional() workflowId?: string;
  @ApiPropertyOptional({ enum: STATUSES }) status?: ExecutionStatus;
  @ApiPropertyOptional({ default: 20 }) limit: number;
  @ApiPropertyOptional({ default: 0 }) offset: number;
}

export class ExecutionErrorDto {
  @ApiProperty() name: string;
  @ApiProperty() message: string;
  @ApiPropertyOptional() nodeId?: string;
  @ApiPropertyOptional() itemIndex?: number;
}

export class ExecutionSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() workflowId: string;
  @ApiProperty() workflowVersionId: string;
  @ApiProperty({ enum: STATUSES }) status: ExecutionStatus;
  @ApiProperty({ enum: EXECUTION_MODES }) mode: ExecutionMode;
  @ApiProperty({
    nullable: true,
    description: 'Calling execution, for sub-workflow runs',
  })
  parentExecutionId: string | null;
  @ApiProperty({ type: ExecutionErrorDto, nullable: true })
  error: ExecutionErrorDto | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true }) startedAt: Date | null;
  @ApiProperty({ nullable: true }) finishedAt: Date | null;
  @ApiProperty({ nullable: true, description: 'When a waiting run resumes' })
  waitTill: Date | null;
}

export class ExecutionStepDto {
  @ApiProperty() nodeId: string;
  @ApiProperty() nodeName: string;
  @ApiProperty({ enum: ['success', 'error'] }) status: 'success' | 'error';
  @ApiProperty({
    description: 'One item array per node output',
    type: 'array',
    items: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  })
  output: StoredItem[][];
  @ApiProperty({ type: ExecutionErrorDto, nullable: true })
  error: ExecutionErrorDto | null;
  @ApiProperty({ description: 'Attempts made (retryOnFail)' }) tries: number;
  @ApiProperty({ description: 'Output came from pinned test data' })
  pinned: boolean;
  @ApiProperty() startedAt: Date;
  @ApiProperty() finishedAt: Date;
}

export class ExecutionDto extends ExecutionSummaryDto {
  @ApiProperty({ type: [ExecutionStepDto] }) steps: ExecutionStepDto[];
}
