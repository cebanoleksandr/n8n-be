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
import { ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import type { CredentialTypeDescription } from '../../engine/types.js';
import {
  CreateCredentialDto,
  createCredentialSchema,
  CredentialDto,
  UpdateCredentialDto,
  updateCredentialSchema,
} from './credentials.dto.js';
import { CredentialsService } from './credentials.service.js';

@ApiTags('credentials')
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
  list(@Query('type') type?: string): Promise<CredentialDto[]> {
    return this.service.list(type);
  }

  @Post('credentials')
  @ApiBody({ type: CreateCredentialDto })
  create(
    @Body(new ZodValidationPipe(createCredentialSchema))
    dto: CreateCredentialDto,
  ): Promise<CredentialDto> {
    return this.service.create(dto);
  }

  @Get('credentials/:id')
  @ApiOkResponse({ type: CredentialDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CredentialDto> {
    return this.service.get(id);
  }

  @Put('credentials/:id')
  @ApiBody({ type: UpdateCredentialDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCredentialSchema))
    dto: UpdateCredentialDto,
  ): Promise<CredentialDto> {
    return this.service.update(id, dto);
  }

  @Delete('credentials/:id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(id);
  }
}
