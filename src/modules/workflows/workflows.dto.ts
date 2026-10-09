import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { workflowGraphSchema } from '../../engine/graph.js';
import type { WorkflowGraph } from '../../engine/types.js';

const graphApiProperty = {
  description:
    'Workflow graph: { nodes: WorkflowNode[], connections: WorkflowConnection[] }',
  type: 'object',
  additionalProperties: true,
  example: {
    nodes: [
      {
        id: 'trigger',
        name: 'Manual Trigger',
        type: 'core.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
    connections: [],
  },
} as const;

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(128),
  graph: workflowGraphSchema.optional(),
});

export class CreateWorkflowDto implements z.infer<typeof createWorkflowSchema> {
  @ApiProperty({ maxLength: 128 })
  name: string;

  @ApiPropertyOptional(graphApiProperty)
  graph?: WorkflowGraph;
}

export const updateWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    active: z.boolean().optional(),
    graph: workflowGraphSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export class UpdateWorkflowDto implements z.infer<typeof updateWorkflowSchema> {
  @ApiPropertyOptional({ maxLength: 128 })
  name?: string;

  @ApiPropertyOptional()
  active?: boolean;

  @ApiPropertyOptional({
    ...graphApiProperty,
    description: 'A changed graph creates a new version',
  })
  graph?: WorkflowGraph;
}

export class WorkflowSummaryDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() active: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class WorkflowDto extends WorkflowSummaryDto {
  @ApiProperty() versionId: string;
  @ApiProperty() version: number;
  @ApiProperty(graphApiProperty) graph: WorkflowGraph;
}

export class WorkflowVersionDto {
  @ApiProperty() id: string;
  @ApiProperty() version: number;
  @ApiProperty() createdAt: Date;
}
