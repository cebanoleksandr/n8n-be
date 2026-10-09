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
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  type Page,
  PaginationQuery,
  paginationSchema,
} from '../../common/pagination.js';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  CreateWorkflowDto,
  createWorkflowSchema,
  importWorkflowSchema,
  type WorkflowImport,
  UpdateWorkflowDto,
  updateWorkflowSchema,
  WorkflowDto,
  WorkflowSummaryDto,
  WorkflowVersionDto,
} from './workflows.dto.js';
import { Auth, MinRole } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/roles.js';
import { WorkflowsService } from './workflows.service.js';

@ApiTags('workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly service: WorkflowsService) {}

  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query(new ZodValidationPipe(paginationSchema)) query: PaginationQuery,
  ): Promise<Page<WorkflowSummaryDto>> {
    return this.service.list(auth.workspaceId, query);
  }

  @Post()
  @MinRole('editor')
  @ApiBody({ type: CreateWorkflowDto })
  create(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(createWorkflowSchema)) dto: CreateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.service.create(auth.workspaceId, dto);
  }

  @Get(':id')
  @ApiOkResponse({ type: WorkflowDto })
  get(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkflowDto> {
    return this.service.get(auth.workspaceId, id);
  }

  @Put(':id')
  @MinRole('editor')
  @ApiBody({ type: UpdateWorkflowDto })
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateWorkflowSchema)) dto: UpdateWorkflowDto,
  ): Promise<WorkflowDto> {
    return this.service.update(auth.workspaceId, id, dto);
  }

  @Delete(':id')
  @MinRole('editor')
  @HttpCode(204)
  remove(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.service.remove(auth.workspaceId, id);
  }

  @Get(':id/versions')
  @ApiOkResponse({ type: [WorkflowVersionDto] })
  versions(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkflowVersionDto[]> {
    return this.service.listVersions(auth.workspaceId, id);
  }

  @Get(':id/versions/:versionId')
  version(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.service.getVersion(auth.workspaceId, id, versionId);
  }

  /** Saves the old graph as a new version. */
  @Post(':id/versions/:versionId/restore')
  @MinRole('editor')
  @HttpCode(200)
  @ApiOkResponse({ type: WorkflowDto })
  restore(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<WorkflowDto> {
    return this.service.restoreVersion(auth.workspaceId, id, versionId);
  }

  @Get(':id/export')
  export(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.export(auth.workspaceId, id);
  }

  @Post('import')
  @MinRole('editor')
  @ApiBody({ description: 'Output of GET /workflows/:id/export' })
  @ApiOkResponse({ type: WorkflowDto })
  import(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(importWorkflowSchema)) dto: WorkflowImport,
  ): Promise<WorkflowDto> {
    return this.service.import(auth.workspaceId, dto);
  }
}
