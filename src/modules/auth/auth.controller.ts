import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import type { Env } from '../../config/env.js';
import { CurrentUserId, Public, UserOnly } from './auth.decorators.js';
import {
  AcceptInvitationDto,
  acceptInvitationSchema,
  ChangePasswordDto,
  changePasswordSchema,
  LoginDto,
  loginSchema,
  MeDto,
  SessionDto,
  SetupDto,
  setupSchema,
} from './auth.dto.js';
import { AuthService, type Session } from './auth.service.js';

/**
 * The refresh token lives in an httpOnly cookie scoped to /api/auth, so page
 * scripts never see it; the short-lived access token is returned in the body.
 */
const REFRESH_COOKIE = 'flow_refresh';
const COOKIE_PATH = '/api/auth';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.secureCookies =
      config.get('NODE_ENV', { infer: true }) === 'production';
  }

  @Public()
  @Get('setup')
  async setupStatus(): Promise<{ needsSetup: boolean }> {
    return { needsSetup: await this.auth.needsSetup() };
  }

  @Public()
  @Post('setup')
  @ApiBody({ type: SetupDto })
  @ApiOkResponse({ type: SessionDto })
  async setup(
    @Body(new ZodValidationPipe(setupSchema)) dto: SetupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    return this.respond(res, await this.auth.setup(dto));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: SessionDto })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    return this.respond(res, await this.auth.login(dto, req.ip ?? 'unknown'));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ type: SessionDto, description: 'Uses the refresh cookie' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    try {
      return this.respond(
        res,
        await this.auth.refresh(readCookie(req, REFRESH_COOKIE)),
      );
    } catch (err) {
      this.clearCookie(res);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readCookie(req, REFRESH_COOKIE));
    this.clearCookie(res);
  }

  @UserOnly()
  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: MeDto })
  me(@CurrentUserId() userId: string): Promise<MeDto> {
    return this.auth.me(userId);
  }

  @UserOnly()
  @Post('password')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiBody({ type: ChangePasswordDto })
  @ApiOkResponse({
    type: SessionDto,
    description: 'Other sessions are signed out',
  })
  async changePassword(
    @CurrentUserId() userId: string,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    return this.respond(res, await this.auth.changePassword(userId, dto));
  }

  @Public()
  @Get('invitations/:token')
  describeInvitation(@Param('token') token: string) {
    return this.auth.describeInvitation(token);
  }

  @Public()
  @Post('invitations/:token/accept')
  @ApiBody({ type: AcceptInvitationDto })
  @ApiOkResponse({ type: SessionDto })
  async acceptInvitation(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptInvitationSchema))
    dto: AcceptInvitationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    return this.respond(res, await this.auth.acceptInvitation(token, dto));
  }

  private respond(res: Response, session: Session): SessionDto {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: COOKIE_PATH,
      expires: session.refreshExpiresAt,
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
