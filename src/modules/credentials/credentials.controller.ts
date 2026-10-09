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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import type { CredentialTypeDescription } from '../../engine/types.js';
import {
  CreateCredentialDto,
  createCredentialSchema,
  CredentialDto,
  UpdateCredentialDto,
  updateCredentialSchema,
} from './credentials.dto.js';
import { Auth, MinRole } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/roles.js';
import { CredentialsService } from './credentials.service.js';

@ApiTags('credentials')
@ApiBearerAuth()
@Controller()
export class CredentialsController {
  constructor(private readonly service: CredentialsService) {}

  @Get('credential-types')
  listTypes(): CredentialTypeDescription[] {
    return this.service.listTypes();
  }

  @Get('credentials')
  @ApiQuery({ name: 'type', required: false })
  @ApiOkResponse({ type: [CredentialDto] })
  list(
    @Auth() auth: AuthContext,
    @Query('type') type?: string,
  ): Promise<CredentialDto[]> {
    return this.service.list(auth.workspaceId, type);
  }

  @Post('credentials')
  @MinRole('editor')
  @ApiBody({ type: CreateCredentialDto })
  create(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(createCredentialSchema))
    dto: CreateCredentialDto,
  ): Promise<CredentialDto> {
    return this.service.create(auth.workspaceId, dto);
  }

  @Get('credentials/:id')
  @MinRole('editor')
  @ApiOkResponse({ type: CredentialDto })
  get(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CredentialDto> {
    return this.service.get(auth.workspaceId, id);
  }

  @Put('credentials/:id')
  @MinRole('editor')
  @ApiBody({ type: UpdateCredentialDto })
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCredentialSchema))
    dto: UpdateCredentialDto,
  ): Promise<CredentialDto> {
    return this.service.update(auth.workspaceId, id, dto);
  }

  @Delete('credentials/:id')
  @MinRole('editor')
  @HttpCode(204)
  remove(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.service.remove(auth.workspaceId, id);
  }
}
