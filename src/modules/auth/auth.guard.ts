import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkspaceMember } from '../workspaces/workspace-member.entity.js';
import {
  AUTH_SCOPE,
  type AuthenticatedRequest,
  type AuthScope,
  MIN_ROLE,
} from './auth.decorators.js';
import { hasRole, type Role } from './roles.js';
import { TokensService } from './tokens.service.js';

export const WORKSPACE_HEADER = 'x-workspace-id';

/**
 * Global guard: every HTTP route needs a valid access token and workspace
 * membership unless marked @Public() or @UserOnly(). The workspace comes from
 * the X-Workspace-Id header, or is implied when the user has exactly one.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    @InjectRepository(WorkspaceMember)
    private readonly members: Repository<WorkspaceMember>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WebSocket connections authenticate in the gateway.
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];
    const scope =
      this.reflector.getAllAndOverride<AuthScope>(AUTH_SCOPE, targets) ??
      'workspace';
    if (scope === 'public') return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    req.userId = this.tokens.verifyAccess(header.slice('Bearer '.length));
    if (scope === 'user') return true;

    const memberships = await this.members.findBy({ userId: req.userId });
    const requested = req.headers[WORKSPACE_HEADER];
    let membership: WorkspaceMember | undefined;
    if (typeof requested === 'string') {
      membership = memberships.find((m) => m.workspaceId === requested);
      if (!membership)
        throw new ForbiddenException('Not a member of this workspace');
    } else if (memberships.length === 1) {
      membership = memberships[0];
    } else if (memberships.length === 0) {
      throw new ForbiddenException('You are not a member of any workspace');
    } else {
      throw new BadRequestException(
        `Member of several workspaces: send the ${WORKSPACE_HEADER} header`,
      );
    }

    const required =
      this.reflector.getAllAndOverride<Role>(MIN_ROLE, targets) ?? 'viewer';
    if (!hasRole(membership.role, required)) {
      throw new ForbiddenException(`Requires the ${required} role`);
    }
    req.auth = {
      userId: req.userId,
      workspaceId: membership.workspaceId,
      role: membership.role,
    };
    return true;
  }
}
