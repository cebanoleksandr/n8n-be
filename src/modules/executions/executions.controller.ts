import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Page } from '../../common/pagination.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  ExecutionDto,
  ExecutionSummaryDto,
  ListExecutionsQuery,
  listExecutionsSchema,
  RunWorkflowDto,
  runWorkflowSchema,
} from './executions.dto.js';
import { ExecutionsService } from './executions.service.js';

@ApiTags('executions')
@Controller()
export class ExecutionsController {
  constructor(private readonly service: ExecutionsService) {}

  @Post('workflows/:id/run')
  @ApiBody({ type: RunWorkflowDto, required: false })
  @ApiOkResponse({ type: ExecutionDto })
  run(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(runWorkflowSchema.default({})))
    dto: RunWorkflowDto,
  ): Promise<ExecutionDto> {
    return this.service.run(id, dto);
  }

  @Get('executions')
  list(
    @Query(new ZodValidationPipe(listExecutionsSchema))
    query: ListExecutionsQuery,
  ): Promise<Page<ExecutionSummaryDto>> {
    return this.service.list(query);
  }

  @Get('executions/:id')
  @ApiOkResponse({ type: ExecutionDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ExecutionDto> {
    return this.service.get(id);
  }
}
