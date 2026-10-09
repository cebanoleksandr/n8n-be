import { Controller, Get, Global, Module } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { NodeRegistry } from '../../engine/node-registry.js';
import type { NodeTypeDescription } from '../../engine/types.js';
import { WorkflowRunner } from '../../engine/workflow-runner.js';
import { builtinNodes } from '../../nodes/index.js';

@ApiTags('node-types')
@Controller('node-types')
export class NodeTypesController {
  constructor(private readonly registry: NodeRegistry) {}

  @Get()
  @ApiOkResponse({
    description:
      'Descriptions of all available node types; the editor builds forms from them',
  })
  list(): NodeTypeDescription[] {
    return this.registry.describeAll();
  }
}

@Global()
@Module({
  controllers: [NodeTypesController],
  providers: [
    { provide: NodeRegistry, useFactory: () => new NodeRegistry(builtinNodes) },
    {
      provide: WorkflowRunner,
      useFactory: (registry: NodeRegistry) => new WorkflowRunner(registry),
      inject: [NodeRegistry],
    },
  ],
  exports: [NodeRegistry, WorkflowRunner],
})
export class NodeTypesModule {}
