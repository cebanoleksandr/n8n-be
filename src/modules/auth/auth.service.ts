import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager, IsNull, Repository } from 'typeorm';
import type { Env } from '../../config/env.js';
import { RateLimiter } from '../../redis/rate-limiter.js';
import { Invitation } from '../workspaces/invitation.entity.js';
import { DEFAULT_WORKSPACE_ID } from '../workspaces/default-workspace.js';
import { WorkspaceMember } from '../workspaces/workspace-member.entity.js';
import { Workspace } from '../workspaces/workspace.entity.js';
import type {
  AcceptInvitationDto,
  ChangePasswordDto,
  LoginDto,
  MeDto,
  RegisterDto,
  UserDto,
} from './auth.dto.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';
import { RefreshToken } from './refresh-token.entity.js';
import { hashToken, TokensService } from './tokens.service.js';
import { User } from './user.entity.js';

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: UserDto;
}

const LOGIN_LIMIT = { perEmail: 5, perIp: 30, windowSeconds: 15 * 60 };
const REGISTER_LIMIT = { perIp: 10, windowSeconds: 60 * 60 };

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(WorkspaceMember)
    private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(Invitation)
    private readonly invitations: Repository<Invitation>,
    private readonly tokens: TokensService,
    private readonly limiter: RateLimiter,
    config: ConfigService<Env, true>,
  ) {
    this.registrationEnabled = config.get('REGISTRATION_ENABLED', {
      infer: true,
    });
  }

  private readonly registrationEnabled: boolean;

  /**
   * Open sign-up: the new user owns a workspace of their own. The very first
   * account takes over the default workspace (and any data created before
   * accounts existed); everyone after gets a fresh one.
   */
  async register(dto: RegisterDto, ip: string): Promise<Session> {
    if (!this.registrationEnabled) {
      throw new ForbiddenException(
        'Registration is disabled; ask for an invitation',
      );
    }
    const retryAfter = await this.limiter.hit(
      `register:${ip}`,
      REGISTER_LIMIT.perIp,
      REGISTER_LIMIT.windowSeconds,
    );
    if (retryAfter > 0) {
      throw new HttpException(
        { message: 'Too many registrations from this address', retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (await this.users.existsBy({ email: dto.email })) {
      throw new ConflictException(
        'This email is already registered; log in instead',
      );
    }

    const passwordHash = await hashPassword(dto.password);
    let user: User;
    try {
      user = await this.dataSource.transaction(async (em) => {
        const created = await em.save(
          em.create(User, { email: dto.email, name: dto.name, passwordHash }),
        );
        // Lock the default workspace so two first sign-ups cannot both claim it.
        const unclaimed = await em.findOne(Workspace, {
          where: { id: DEFAULT_WORKSPACE_ID },
          lock: { mode: 'pessimistic_write' },
        });
        let workspaceId: string;
        if (
          unclaimed &&
          !(await em.existsBy(WorkspaceMember, {
            workspaceId: DEFAULT_WORKSPACE_ID,
          }))
        ) {
          workspaceId = DEFAULT_WORKSPACE_ID;
          if (dto.workspaceName) {
            await em.update(Workspace, workspaceId, {
              name: dto.workspaceName,
            });
          }
        } else {
          const workspace = await em.save(
            em.create(Workspace, {
              name: dto.workspaceName ?? `${dto.name}'s workspace`,
            }),
          );
          workspaceId = workspace.id;
        }
        await em.insert(WorkspaceMember, {
          workspaceId,
          userId: created.id,
          role: 'owner',
        });
        return created;
      });
    } catch (err) {
      // Lost a race with a sign-up for the same email.
      if (
        (err as { driverError?: { code?: string } }).driverError?.code ===
        '23505'
      ) {
        throw new ConflictException(
          'This email is already registered; log in instead',
        );
      }
      throw err;
    }
    return this.startSession(user);
  }

  async login(dto: LoginDto, ip: string): Promise<Session> {
    const waits = await Promise.all([
      this.limiter.hit(
        `email:${dto.email}`,
        LOGIN_LIMIT.perEmail,
        LOGIN_LIMIT.windowSeconds,
      ),
      this.limiter.hit(
        `ip:${ip}`,
        LOGIN_LIMIT.perIp,
        LOGIN_LIMIT.windowSeconds,
      ),
    ]);
    const retryAfter = Math.max(...waits);
    if (retryAfter > 0) {
      throw new HttpException(
        { message: 'Too many login attempts', retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.users.findOneBy({ email: dto.email });
    // Hash even for unknown emails so response time does not reveal accounts.
    const valid = await verifyPassword(
      dto.password,
      user?.passwordHash ?? (await dummyPasswordHash()),
    );
    if (!user || !valid)
      throw new UnauthorizedException('Invalid email or password');

    await this.limiter.reset(`email:${dto.email}`);
    return this.startSession(user);
  }

  /**
   * Rotates the refresh token. Presenting an already rotated token means it
   * leaked: the whole family (every session descended from that login) is revoked.
   */
  async refresh(rawToken: string | undefined): Promise<Session> {
    if (!rawToken) throw new UnauthorizedException('No refresh token');
    const stored = await this.refreshTokens.findOneBy({
      tokenHash: hashToken(rawToken),
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');
    if (stored.revokedAt) {
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Refresh token was already used');
    }
    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const rotated = await this.refreshTokens.update(
      { id: stored.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (!rotated.affected) {
      // Lost a race with another refresh using the same token: treat as reuse.
      await this.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Refresh token was already used');
    }
    const user = await this.users.findOneBy({ id: stored.userId });
    if (!user) throw new UnauthorizedException('User no longer exists');
    return this.issue(user, stored.familyId);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const stored = await this.refreshTokens.findOneBy({
      tokenHash: hashToken(rawToken),
    });
    if (stored) await this.revokeFamily(stored.familyId);
  }

  async me(userId: string): Promise<MeDto> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException('User no longer exists');
    const memberships = await this.members.find({
      where: { userId },
      relations: { workspace: true },
      order: { createdAt: 'ASC' },
    });
    return {
      ...toUserDto(user),
      workspaces: memberships.map((m) => ({
        workspaceId: m.workspaceId,
        workspaceName: m.workspace!.name,
        role: m.role,
      })),
    };
  }

  /** Signs out every other session. */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<Session> {
    const user = await this.users.findOneBy({ id: userId });
    if (
      !user ||
      !(await verifyPassword(dto.currentPassword, user.passwordHash))
    ) {
      throw new UnauthorizedException('Current password is wrong');
    }
    user.passwordHash = await hashPassword(dto.newPassword);
    await this.users.save(user);
    await this.refreshTokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return this.startSession(user);
  }

  async describeInvitation(rawToken: string) {
    const invitation = await this.findOpenInvitation(
      this.dataSource.manager,
      rawToken,
    );
    const workspace = await this.dataSource.manager.findOneByOrFail(Workspace, {
      id: invitation.workspaceId,
    });
    return {
      email: invitation.email,
      role: invitation.role,
      workspaceName: workspace.name,
      expiresAt: invitation.expiresAt,
      hasAccount: await this.users.existsBy({ email: invitation.email }),
    };
  }

  /** New email: creates the account. Existing account: checks its password. */
  async acceptInvitation(
    rawToken: string,
    dto: AcceptInvitationDto,
  ): Promise<Session> {
    const user = await this.dataSource.transaction(async (em) => {
      const invitation = await this.findOpenInvitation(em, rawToken, true);
      let account = await em.findOneBy(User, { email: invitation.email });
      if (account) {
        if (!(await verifyPassword(dto.password, account.passwordHash))) {
          throw new UnauthorizedException(
            'Wrong password for the existing account',
          );
        }
      } else {
        if (!dto.name)
          throw new ConflictException('name is required for a new account');
        account = await em.save(
          em.create(User, {
            email: invitation.email,
            name: dto.name,
            passwordHash: await hashPassword(dto.password),
          }),
        );
      }
      const already = await em.existsBy(WorkspaceMember, {
        workspaceId: invitation.workspaceId,
        userId: account.id,
      });
      if (!already) {
        await em.insert(WorkspaceMember, {
          workspaceId: invitation.workspaceId,
          userId: account.id,
          role: invitation.role,
        });
      }
      await em.update(Invitation, invitation.id, { acceptedAt: new Date() });
      return account;
    });
    return this.startSession(user);
  }

  private async findOpenInvitation(
    em: EntityManager,
    rawToken: string,
    lock = false,
  ): Promise<Invitation> {
    const invitation = await em.findOne(Invitation, {
      where: { tokenHash: hashToken(rawToken), acceptedAt: IsNull() },
      ...(lock && { lock: { mode: 'pessimistic_write' as const } }),
    });
    if (!invitation || invitation.expiresAt < new Date()) {
      throw new NotFoundException('Invitation not found or expired');
    }
    return invitation;
  }

  private startSession(user: User): Promise<Session> {
    return this.issue(user, randomUUID());
  }

  private async issue(user: User, familyId: string): Promise<Session> {
    const { token, hash } = this.tokens.newOpaqueToken();
    const expiresAt = new Date(Date.now() + this.tokens.refreshTtlMs);
    await this.refreshTokens.insert({
      userId: user.id,
      familyId,
      tokenHash: hash,
      expiresAt,
    });
    return {
      accessToken: this.tokens.signAccess(user.id),
      expiresIn: this.tokens.accessTtlSeconds,
      refreshToken: token,
      refreshExpiresAt: expiresAt,
      user: toUserDto(user),
    };
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.refreshTokens.update(
      { familyId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }
}

function toUserDto(user: User): UserDto {
  return { id: user.id, email: user.email, name: user.name };
}
