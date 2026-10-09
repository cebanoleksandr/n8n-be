import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';
import { RateLimiter } from '../../redis/rate-limiter.js';
import { redisOptionsFromUrl } from '../../redis/redis-options.js';
import { Invitation } from '../workspaces/invitation.entity.js';
import { MembersController } from '../workspaces/members.controller.js';
import { MembersService } from '../workspaces/members.service.js';
import { WorkspaceMember } from '../workspaces/workspace-member.entity.js';
import { Workspace } from '../workspaces/workspace.entity.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { RefreshToken } from './refresh-token.entity.js';
import { TokensService } from './tokens.service.js';
import { User } from './user.entity.js';

/** Users, sessions, workspace membership; installs the global AuthGuard. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      RefreshToken,
      WorkspaceMember,
      Invitation,
      Workspace,
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController, MembersController],
  providers: [
    AuthService,
    TokensService,
    MembersService,
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: RateLimiter,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new RateLimiter(
          new Redis({
            ...redisOptionsFromUrl(config.get('REDIS_URL', { infer: true })),
            maxRetriesPerRequest: 3,
          }),
          'flow:ratelimit:login',
        ),
    },
  ],
  exports: [TokensService, TypeOrmModule],
})
export class AuthModule {}
