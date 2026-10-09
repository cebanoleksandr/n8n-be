import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { paginationSchema } from '../../common/pagination.js';
import type { JsonObject } from '../../engine/types.js';
import type { StoredItem } from './execution-step.entity.js';
import type { ExecutionMode, ExecutionStatus } from './execution.entity.js';

const STATUSES = [
  'running',
  'success',
  'error',
  'canceled',
] as const satisfies ExecutionStatus[];

export const runWorkflowSchema = z.object({
  startNodeId: z.string().optional(),
  /** JSON objects handed to the trigger node as items. */
  input: z.array(z.record(z.string(), z.unknown())).optional(),
});

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
}

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
  @ApiProperty() mode: ExecutionMode;
  @ApiProperty({ type: ExecutionErrorDto, nullable: true })
  error: ExecutionErrorDto | null;
  @ApiProperty() startedAt: Date;
  @ApiProperty({ nullable: true }) finishedAt: Date | null;
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
  @ApiProperty() startedAt: Date;
  @ApiProperty() finishedAt: Date;
}

export class ExecutionDto extends ExecutionSummaryDto {
  @ApiProperty({ type: [ExecutionStepDto] }) steps: ExecutionStepDto[];
}
