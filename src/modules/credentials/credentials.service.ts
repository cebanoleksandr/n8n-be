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
    const data = this.validate(dto.type, dto.data);
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
      const merged = {
        ...this.cipher.decrypt<CredentialData>(credential.data),
        ...dto.data,
      };
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
        return this.cipher.decrypt<CredentialData>(credential.data);
      },
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
      if (!known.has(key)) issues.push(`Unknown field "${key}"`);
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
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      data: Object.fromEntries(
        Object.entries(data).filter(([k]) => !secret.has(k)),
      ),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }
}
