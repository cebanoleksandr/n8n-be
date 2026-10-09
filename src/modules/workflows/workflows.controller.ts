import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  type Page,
  PaginationQuery,
  paginationSchema,
} from '../../common/pagination.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  CreateWorkflowDto,
  createWorkflowSchema,
  UpdateWorkflowDto,
  updateWorkflowSchema,
  WorkflowDto,
  WorkflowSummaryDto,
  WorkflowVersionDto,
} from './workflows.dto.js';
import { WorkflowsService } from './workflows.service.js';

@ApiTags('workflows')
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly service: WorkflowsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(paginationSchema)) query: PaginationQuery,
  ): Promise<Page<WorkflowSummaryDto>> {
    return this.service.list(query);
  }

  @Post()
  @ApiBody({ type: CreateWorkflowDto })
  create(
    @Body(new ZodValidationPipe(createWorkflowSchema)) dto: CreateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.service.create(dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: WorkflowDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<WorkflowDto> {
    return this.service.get(id);
  }

  @Put(':id')
  @ApiBody({ type: UpdateWorkflowDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateWorkflowSchema)) dto: UpdateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(id);
  }

  @Get(':id/versions')
  @ApiOkResponse({ type: [WorkflowVersionDto] })
  versions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkflowVersionDto[]> {
    return this.service.listVersions(id);
  }
}
