import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { Page } from '../../common/pagination.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  ExecutionDto,
  ExecutionSummaryDto,
  ListExecutionsQuery,
  listExecutionsSchema,
  RunWorkflowDto,
  runQuerySchema,
  runWorkflowSchema,
} from './executions.dto.js';
import { ExecutionsService, toSummary } from './executions.service.js';

const RUN_WAIT_TIMEOUT_MS = 60_000;

@ApiTags('executions')
@Controller()
export class ExecutionsController {
  constructor(private readonly service: ExecutionsService) {}

  @Post('workflows/:id/run')
  @ApiBody({ type: RunWorkflowDto, required: false })
  @ApiQuery({
    name: 'wait',
    required: false,
    description: `true: respond when the run finishes (up to ${RUN_WAIT_TIMEOUT_MS / 1000}s)`,
  })
  @ApiAcceptedResponse({ type: ExecutionSummaryDto, description: 'Queued' })
  @ApiOkResponse({ type: ExecutionDto, description: 'With ?wait=true' })
  async run(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(runWorkflowSchema.default({})))
    dto: RunWorkflowDto,
    @Query(new ZodValidationPipe(runQuerySchema)) query: { wait: boolean },
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExecutionSummaryDto | ExecutionDto> {
    const execution = await this.service.start(id, {
      mode: 'manual',
      startNodeId: dto.startNodeId,
      input: dto.input,
    });
    if (query.wait) {
      res.status(200);
      return this.service.waitForFinish(execution.id, RUN_WAIT_TIMEOUT_MS);
    }
    res.status(202);
    return toSummary(execution);
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
