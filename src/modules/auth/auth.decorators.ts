import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext, Role } from './roles.js';

export const AUTH_SCOPE = 'auth:scope';
export const MIN_ROLE = 'auth:minRole';

/**
 * Every route requires a workspace member by default (deny by default).
 * public: no token. user: valid token, no workspace (e.g. /auth/me).
 */
export type AuthScope = 'public' | 'user' | 'workspace';

export const Public = () =>
  SetMetadata(AUTH_SCOPE, 'public' satisfies AuthScope);
export const UserOnly = () =>
  SetMetadata(AUTH_SCOPE, 'user' satisfies AuthScope);
/** Minimum workspace role; the default is viewer. */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);

export interface AuthenticatedRequest extends Request {
  userId?: string;
  auth?: AuthContext;
}

/** The caller's user and current workspace (workspace-scoped routes). */
export const Auth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth!,
);

/** The caller's user id (user- and workspace-scoped routes). */
export const CurrentUserId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().userId!,
);
