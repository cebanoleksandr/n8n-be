import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Env } from '../../config/env.js';
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
import { Auth, MinRole, Public } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/roles.js';
import { CredentialsService } from './credentials.service.js';
import { OAuth2Service } from './oauth2.service.js';

@ApiTags('credentials')
@ApiBearerAuth()
@Controller()
export class CredentialsController {
  private readonly editorOrigin: string | undefined;

  constructor(
    private readonly service: CredentialsService,
    private readonly oauth2: OAuth2Service,
    config: ConfigService<Env, true>,
  ) {
    this.editorOrigin = config.get('CORS_ORIGINS', { infer: true })[0];
  }

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

  /** Open this URL (popup) to connect an OAuth2 credential. */
  @Get('credentials/:id/oauth2/auth-url')
  @MinRole('editor')
  oauth2AuthUrl(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string; redirectUri: string }> {
    return this.oauth2.authorizationUrl(auth.workspaceId, id);
  }

  /** The redirect URI to register at OAuth providers. */
  @Get('oauth2/redirect-uri')
  redirectUri(): { redirectUri: string } {
    return { redirectUri: this.oauth2.redirectUri() };
  }

  /** Provider redirect target; answers with a small page that closes the popup. */
  @Public()
  @Get('oauth2/callback')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'",
  )
  async oauth2Callback(
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    try {
      const { credentialId } = await this.oauth2.handleCallback(query);
      return callbackPage(
        true,
        'Connected. You can close this window.',
        credentialId,
        this.editorOrigin,
      );
    } catch (err) {
      res.status(400);
      const message = err instanceof Error ? err.message : 'Connection failed';
      return callbackPage(false, message, undefined, this.editorOrigin);
    }
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Tells the editor window (opener) about the result, only if it is on the
 * configured frontend origin, then shows the message.
 */
function callbackPage(
  ok: boolean,
  message: string,
  credentialId: string | undefined,
  editorOrigin: string | undefined,
): string {
  const payload = JSON.stringify({
    type: 'oauth2-callback',
    ok,
    credentialId,
    message,
  }).replace(/</g, '\\u003c');
  const notify = editorOrigin
    ? `<script>window.opener && window.opener.postMessage(${payload}, ${JSON.stringify(editorOrigin)});${ok ? 'window.close();' : ''}</script>`
    : '';
  return `<!doctype html><meta charset="utf-8"><title>OAuth2</title><p>${escapeHtml(message)}</p>${notify}`;
}
