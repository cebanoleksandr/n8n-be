import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NodeOperationError } from '../../engine/errors.js';
import type {
  CredentialsProvider,
  CredentialTypeDescription,
} from '../../engine/types.js';
import { builtinCredentialTypes } from '../../nodes/index.js';
import { Cipher } from './cipher.js';
import {
  OAuth2Service,
  TOKEN_FIELD,
  type TokenData,
} from './oauth2.service.js';
import { Credential } from './credential.entity.js';
import type {
  CreateCredentialDto,
  CredentialDto,
  UpdateCredentialDto,
} from './credentials.dto.js';

type CredentialData = Record<string, unknown>;

@Injectable()
export class CredentialsService {
  private readonly types = new Map(
    builtinCredentialTypes.map((t) => [t.type, t]),
  );

  constructor(
    @InjectRepository(Credential)
    private readonly credentials: Repository<Credential>,
    private readonly cipher: Cipher,
    private readonly oauth2: OAuth2Service,
  ) {}

  listTypes(): CredentialTypeDescription[] {
    return [...this.types.values()];
  }

  async list(workspaceId: string, type?: string): Promise<CredentialDto[]> {
    const items = await this.credentials.find({
      where: { workspaceId, ...(type && { type }) },
      order: { name: 'ASC' },
    });
    return items.map((c) => this.toDto(c));
  }

  async get(workspaceId: string, id: string): Promise<CredentialDto> {
    return this.toDto(await this.findOrFail(workspaceId, id));
  }

  async create(
    workspaceId: string,
    dto: CreateCredentialDto,
  ): Promise<CredentialDto> {
    const data = this.validate(dto.type, withoutTokens(dto.data));
    const saved = await this.credentials.save(
      this.credentials.create({
        workspaceId,
        name: dto.name,
        type: dto.type,
        data: this.cipher.encrypt(data),
      }),
    );
    return this.toDto(saved);
  }

  async update(
    workspaceId: string,
    id: string,
    dto: UpdateCredentialDto,
  ): Promise<CredentialDto> {
    const credential = await this.findOrFail(workspaceId, id);
    if (dto.name !== undefined) credential.name = dto.name;
    if (dto.data) {
      const current = this.cipher.decrypt<CredentialData>(credential.data);
      const patch = withoutTokens(dto.data);
      const merged: CredentialData = { ...current, ...patch };
      // Tokens belong to the old client/endpoint settings.
      if (OAUTH_SETTINGS.some((k) => k in patch && patch[k] !== current[k])) {
        delete merged[TOKEN_FIELD];
      }
      credential.data = this.cipher.encrypt(
        this.validate(credential.type, merged),
      );
    }
    return this.toDto(await this.credentials.save(credential));
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const result = await this.credentials.delete({
      id,
      workspaceId,
    });
    if (!result.affected)
      throw new NotFoundException(`Credential ${id} not found`);
  }

  /** Decrypting provider for the engine, scoped to one workspace. */
  providerFor(workspaceId: string): CredentialsProvider {
    return {
      get: async (id, type) => {
        const credential = await this.credentials.findOneBy({
          id,
          workspaceId,
        });
        if (!credential)
          throw new NodeOperationError(`Credential ${id} not found`);
        if (credential.type !== type) {
          throw new NodeOperationError(
            `Credential "${credential.name}" is of type ${credential.type}, expected ${type}`,
          );
        }
        return withoutTokens(
          this.cipher.decrypt<CredentialData>(credential.data),
        );
      },
      oauth2AccessToken: (id) => this.oauth2.accessToken(workspaceId, id),
    };
  }

  private async findOrFail(
    workspaceId: string,
    id: string,
  ): Promise<Credential> {
    const credential = await this.credentials.findOneBy({
      id,
      workspaceId,
    });
    if (!credential) throw new NotFoundException(`Credential ${id} not found`);
    return credential;
  }

  private validate(type: string, data: CredentialData): CredentialData {
    const definition = this.types.get(type);
    if (!definition)
      throw new BadRequestException(`Unknown credential type "${type}"`);

    const issues: string[] = [];
    const known = new Set(definition.properties.map((p) => p.name));
    for (const key of Object.keys(data)) {
      if (!known.has(key) && key !== TOKEN_FIELD)
        issues.push(`Unknown field "${key}"`);
    }
    for (const p of definition.properties) {
      const value = data[p.name];
      if (value === undefined || value === '') {
        if (p.required) issues.push(`"${p.name}" is required`);
      } else if (p.type === 'string' && typeof value !== 'string') {
        issues.push(`"${p.name}" must be a string`);
      }
    }
    if (issues.length > 0) {
      throw new BadRequestException({
        message: 'Invalid credential data',
        issues,
      });
    }
    return data;
  }

  private toDto(c: Credential): CredentialDto {
    const data = this.cipher.decrypt<CredentialData>(c.data);
    const secret = new Set(
      this.types
        .get(c.type)
        ?.properties.filter((p) => p.secret)
        .map((p) => p.name) ?? [],
    );
    const tokens = data[TOKEN_FIELD] as TokenData | undefined;
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      data: Object.fromEntries(
        Object.entries(data).filter(
          ([k]) => !secret.has(k) && k !== TOKEN_FIELD,
        ),
      ),
      ...(this.types.get(c.type)?.oauth2 && {
        oauth2: {
          connected: tokens !== undefined,
          expiresAt: tokens?.expiresAt ? new Date(tokens.expiresAt) : null,
        },
      }),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}

/** OAuth2 settings whose change invalidates stored tokens. */
const OAUTH_SETTINGS = [
  'grantType',
  'authUrl',
  'accessTokenUrl',
  'clientId',
  'clientSecret',
  'scope',
];

/** Users can never write (or, through nodes, read) the server-managed tokens. */
function withoutTokens(data: CredentialData): CredentialData {
  const { [TOKEN_FIELD]: _tokens, ...rest } = data;
  return rest;
}
