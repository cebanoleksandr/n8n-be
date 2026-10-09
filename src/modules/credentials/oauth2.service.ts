import {
  BadRequestException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import type { Env } from '../../config/env.js';
import { NodeOperationError } from '../../engine/errors.js';
import { OAUTH2_TYPE } from '../../nodes/credentials.js';
import { redisOptionsFromUrl } from '../../redis/redis-options.js';
import { Cipher } from './cipher.js';
import { Credential } from './credential.entity.js';

/** Server-managed field inside OAuth2 credential data; never set by users. */
export const TOKEN_FIELD = 'oauthTokenData';

export interface TokenData {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the provider gives no expiry. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

interface OAuth2Data {
  grantType: 'authorizationCode' | 'clientCredentials';
  authUrl?: string;
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  authQueryParameters?: string;
  clientAuth?: 'body' | 'header';
  [TOKEN_FIELD]?: TokenData;
}

interface PendingAuth {
  workspaceId: string;
  credentialId: string;
  codeVerifier: string;
}

const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = 'flow:oauth2:state:';
/** Refresh this long before the provider's expiry. */
const EXPIRY_MARGIN_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/**
 * OAuth2 for credentials: authorization code (with PKCE) and client
 * credentials grants, token storage in the encrypted credential, refresh.
 */
@Injectable()
export class OAuth2Service implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly publicUrl: string;
  /** In-process de-duplication of concurrent refreshes of one credential. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    @InjectRepository(Credential)
    private readonly credentials: Repository<Credential>,
    private readonly cipher: Cipher,
    config: ConfigService<Env, true>,
  ) {
    this.redis = new Redis({
      ...redisOptionsFromUrl(config.get('REDIS_URL', { infer: true })),
      maxRetriesPerRequest: 3,
    });
    this.publicUrl = (
      config.get('PUBLIC_URL', { infer: true }) ??
      `http://localhost:${config.get('PORT', { infer: true })}`
    ).replace(/\/+$/, '');
  }

  /** Register this at the OAuth provider. */
  redirectUri(): string {
    return `${this.publicUrl}/api/oauth2/callback`;
  }

  /** URL to open (in a popup) so the user can grant access. */
  async authorizationUrl(workspaceId: string, credentialId: string) {
    const { data } = await this.load(workspaceId, credentialId);
    if (data.grantType !== 'authorizationCode' || !data.authUrl) {
      throw new BadRequestException(
        'Only Authorization Code credentials with an Authorization URL can be connected',
      );
    }
    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const pending: PendingAuth = { workspaceId, credentialId, codeVerifier };
    await this.redis.set(
      STATE_PREFIX + state,
      JSON.stringify(pending),
      'EX',
      STATE_TTL_SECONDS,
    );

    const url = new URL(data.authUrl);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: data.clientId,
      redirect_uri: this.redirectUri(),
      state,
      code_challenge: createHash('sha256')
        .update(codeVerifier)
        .digest('base64url'),
      code_challenge_method: 'S256',
      ...(data.scope && { scope: data.scope }),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (const [k, v] of new URLSearchParams(data.authQueryParameters ?? '')) {
      url.searchParams.set(k, v);
    }
    return { url: url.toString(), redirectUri: this.redirectUri() };
  }

  /** Handles the provider redirect; the state is single use. */
  async handleCallback(query: {
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }): Promise<{ credentialId: string }> {
    if (!query.state) throw new BadRequestException('Missing state');
    const raw = await this.redis.getdel(STATE_PREFIX + query.state);
    if (!raw)
      throw new BadRequestException('Unknown or expired state; start again');
    const pending = JSON.parse(raw) as PendingAuth;
    if (query.error) {
      throw new BadRequestException(
        `The provider refused access: ${query.error_description ?? query.error}`,
      );
    }
    if (!query.code) throw new BadRequestException('Missing code');

    const { credential, data } = await this.load(
      pending.workspaceId,
      pending.credentialId,
    );
    const tokens = await this.requestToken(data, {
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: this.redirectUri(),
      code_verifier: pending.codeVerifier,
    });
    await this.saveTokens(credential, data, tokens);
    return { credentialId: credential.id };
  }

  /** Valid access token; refreshes (or re-requests for client credentials) as needed. */
  accessToken(workspaceId: string, credentialId: string): Promise<string> {
    const key = `${workspaceId}:${credentialId}`;
    let pending = this.refreshing.get(key);
    if (!pending) {
      pending = this.resolveToken(workspaceId, credentialId).finally(() =>
        this.refreshing.delete(key),
      );
      this.refreshing.set(key, pending);
    }
    return pending;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  private async resolveToken(
    workspaceId: string,
    credentialId: string,
  ): Promise<string> {
    const { credential, data } = await this.load(
      workspaceId,
      credentialId,
      NodeOperationError,
    );
    const current = data[TOKEN_FIELD];
    if (current && !isExpired(current)) return current.accessToken;

    let tokens: TokenData;
    if (data.grantType === 'clientCredentials') {
      tokens = await this.requestToken(data, {
        grant_type: 'client_credentials',
        ...(data.scope && { scope: data.scope }),
      });
    } else if (current?.refreshToken) {
      tokens = await this.requestToken(data, {
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      });
      // Providers may omit the refresh token when it does not rotate.
      tokens.refreshToken ??= current.refreshToken;
    } else {
      throw new NodeOperationError(
        current
          ? `Credential "${credential.name}" has expired; connect it again`
          : `Credential "${credential.name}" is not connected yet`,
      );
    }
    await this.saveTokens(credential, data, tokens);
    return tokens.accessToken;
  }

  private async requestToken(
    data: OAuth2Data,
    params: Record<string, string>,
  ): Promise<TokenData> {
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (data.clientAuth === 'header') {
      const basic = Buffer.from(
        `${encodeURIComponent(data.clientId)}:${encodeURIComponent(data.clientSecret)}`,
      ).toString('base64');
      headers.authorization = `Basic ${basic}`;
    } else {
      body.set('client_id', data.clientId);
      body.set('client_secret', data.clientSecret);
    }

    let response: Response;
    try {
      response = await fetch(data.accessTokenUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new NodeOperationError(
        `Token request failed: ${(err as Error).message}`,
      );
    }
    const text = await response.text();
    // Some providers still answer form-encoded.
    const parsed: Record<string, unknown> = (() => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return Object.fromEntries(new URLSearchParams(text));
      }
    })();
    if (!response.ok || typeof parsed.access_token !== 'string') {
      const reason =
        (parsed.error_description as string | undefined) ??
        (parsed.error as string | undefined) ??
        `status ${response.status}`;
      throw new NodeOperationError(`Token request was rejected: ${reason}`);
    }
    const expiresIn = Number(parsed.expires_in);
    return {
      accessToken: parsed.access_token,
      ...(typeof parsed.refresh_token === 'string' && {
        refreshToken: parsed.refresh_token,
      }),
      ...(Number.isFinite(expiresIn) &&
        expiresIn > 0 && {
          expiresAt: Date.now() + expiresIn * 1000,
        }),
      ...(typeof parsed.token_type === 'string' && {
        tokenType: parsed.token_type,
      }),
      ...(typeof parsed.scope === 'string' && { scope: parsed.scope }),
    };
  }

  private async saveTokens(
    credential: Credential,
    data: OAuth2Data,
    tokens: TokenData,
  ) {
    credential.data = this.cipher.encrypt({ ...data, [TOKEN_FIELD]: tokens });
    await this.credentials.save(credential);
  }

  private async load(
    workspaceId: string,
    id: string,
    NotFound: new (message: string) => Error = NotFoundException,
  ): Promise<{ credential: Credential; data: OAuth2Data }> {
    const credential = await this.credentials.findOneBy({ id, workspaceId });
    if (!credential) throw new NotFound(`Credential ${id} not found`);
    if (credential.type !== OAUTH2_TYPE) {
      throw new BadRequestException(
        `Credential "${credential.name}" is not an OAuth2 credential`,
      );
    }
    return {
      credential,
      data: this.cipher.decrypt<OAuth2Data>(credential.data),
    };
  }
}

function isExpired(tokens: TokenData): boolean {
  return (
    tokens.expiresAt !== undefined &&
    tokens.expiresAt - EXPIRY_MARGIN_MS <= Date.now()
  );
}
