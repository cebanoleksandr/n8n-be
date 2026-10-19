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
import type { CookieOptions, Request, Response } from 'express';
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
  RegisterDto,
  registerSchema,
} from './auth.dto.js';
import { AuthService, type Session } from './auth.service.js';
import { REFRESH_COOKIE, refreshCookieOptions } from './refresh-cookie.js';

/**
 * The refresh token lives in an httpOnly cookie scoped to /api/auth, so page
 * scripts never see it; the short-lived access token is returned in the body.
 */

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly cookie: CookieOptions;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.cookie = refreshCookieOptions(
      config.get('NODE_ENV', { infer: true }) === 'production',
      config.get('COOKIE_SAME_SITE', { infer: true }),
    );
  }

  /** Open sign-up: creates the account and a workspace owned by it. */
  @Public()
  @Post('register')
  @ApiBody({ type: RegisterDto })
  @ApiOkResponse({ type: SessionDto })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    return this.respond(
      res,
      await this.auth.register(dto, req.ip ?? 'unknown'),
    );
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
      ...this.cookie,
      expires: session.refreshExpiresAt,
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.cookie);
  }
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
