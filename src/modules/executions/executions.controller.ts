import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
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
import { Auth, MinRole } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/roles.js';
import { ExecutionsService, toSummary } from './executions.service.js';

const RUN_WAIT_TIMEOUT_MS = 60_000;

@ApiTags('executions')
@ApiBearerAuth()
@Controller()
export class ExecutionsController {
  constructor(private readonly service: ExecutionsService) {}

  @Post('workflows/:id/run')
  @MinRole('editor')
  @ApiBody({ type: RunWorkflowDto, required: false })
  @ApiQuery({
    name: 'wait',
    required: false,
    description: `true: respond when the run finishes (up to ${RUN_WAIT_TIMEOUT_MS / 1000}s)`,
  })
  @ApiAcceptedResponse({ type: ExecutionSummaryDto, description: 'Queued' })
  @ApiOkResponse({ type: ExecutionDto, description: 'With ?wait=true' })
  async run(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(runWorkflowSchema.default({})))
    dto: RunWorkflowDto,
    @Query(new ZodValidationPipe(runQuerySchema)) query: { wait: boolean },
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExecutionSummaryDto | ExecutionDto> {
    const execution = await this.service.start(auth.workspaceId, id, {
      mode: 'manual',
      startNodeId: dto.startNodeId,
      input: dto.input,
      destinationNodeId: dto.destinationNodeId,
      runFromNodeId: dto.runFromNodeId,
      sourceExecutionId: dto.sourceExecutionId,
    });
    if (query.wait) {
      res.status(200);
      return this.service.waitForFinish(
        auth.workspaceId,
        execution.id,
        RUN_WAIT_TIMEOUT_MS,
      );
    }
    res.status(202);
    return toSummary(execution);
  }

  @Get('executions')
  list(
    @Auth() auth: AuthContext,
    @Query(new ZodValidationPipe(listExecutionsSchema))
    query: ListExecutionsQuery,
  ): Promise<Page<ExecutionSummaryDto>> {
    return this.service.list(auth.workspaceId, query);
  }

  @Post('executions/:id/cancel')
  @MinRole('editor')
  @HttpCode(200)
  @ApiOkResponse({
    type: ExecutionDto,
    description: 'Status is "canceled" once the worker stopped the run',
  })
  @ApiConflictResponse({ description: 'Execution already finished' })
  cancel(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExecutionDto> {
    return this.service.cancel(auth.workspaceId, id);
  }

  @Get('executions/:id')
  @ApiOkResponse({ type: ExecutionDto })
  get(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ExecutionDto> {
    return this.service.get(auth.workspaceId, id);
  }
}
