import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';

interface AccessPayload {
  sub: string;
  typ: 'access';
}

@Injectable()
export class TokensService {
  readonly accessTtlSeconds: number;
  readonly refreshTtlMs: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.accessTtlSeconds = config.get('ACCESS_TOKEN_TTL_SECONDS', {
      infer: true,
    });
    this.refreshTtlMs =
      config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) *
      24 *
      60 *
      60 *
      1000;
  }

  signAccess(userId: string): string {
    const payload: AccessPayload = { sub: userId, typ: 'access' };
    return this.jwt.sign(payload, { expiresIn: this.accessTtlSeconds });
  }

  /** Returns the user id or throws 401. */
  verifyAccess(token: string): string {
    try {
      const payload = this.jwt.verify<AccessPayload>(token, {
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string')
        throw new Error();
      return payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  /** Opaque random token; only its hash is stored. */
  newOpaqueToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
