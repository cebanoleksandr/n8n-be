import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  type FindOptionsWhere,
  In,
  IsNull,
  LessThan,
  Repository,
} from 'typeorm';
import type { Env } from '../../config/env.js';
import { NodeOperationError } from '../../engine/errors.js';
import type { BinaryMeta, BinaryRef, BinaryStore } from '../../engine/types.js';
import { BinaryData } from './binary-data.entity.js';

export interface BinaryScope {
  workspaceId: string;
  workflowId: string;
  executionId?: string;
}

/** Orphans younger than this are kept so an in-flight upload is never deleted. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const CLEANUP_BATCH = 500;

@Injectable()
export class BinaryDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BinaryDataService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  readonly maxBytes: number;

  constructor(
    config: ConfigService<Env, true>,
    @InjectRepository(BinaryData)
    private readonly files: Repository<BinaryData>,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.maxBytes = config.get('BINARY_MAX_BYTES', { infer: true });
    this.s3 = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket ${this.bucket}`);
      } catch (err) {
        // Keep starting: only nodes that touch files will fail.
        this.logger.error(
          `Object storage unavailable: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Throws when the bucket is unreachable (readiness check). */
  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }

  /** Engine-facing store bound to one workflow (and execution, when known). */
  storeFor(scope: BinaryScope): BinaryStore {
    return {
      put: (data, meta) => this.put(scope, data, meta),
      get: (ref) => this.read(scope.workspaceId, ref.id),
    };
  }

  async put(
    scope: BinaryScope,
    data: Buffer,
    meta: BinaryMeta,
  ): Promise<BinaryRef> {
    if (data.length > this.maxBytes) {
      throw new NodeOperationError(
        `File is ${data.length} bytes, the limit is ${this.maxBytes}`,
      );
    }
    const id = randomUUID();
    const storageKey = `${scope.workspaceId}/${id}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: data,
        ContentType: meta.mimeType,
      }),
    );
    await this.files.insert({
      id,
      workspaceId: scope.workspaceId,
      workflowId: scope.workflowId,
      executionId: scope.executionId ?? null,
      fileName: meta.fileName?.slice(0, 255) ?? null,
      mimeType: meta.mimeType.slice(0, 255),
      size: data.length,
      storageKey,
    });
    return {
      id,
      ...(meta.fileName ? { fileName: meta.fileName } : {}),
      mimeType: meta.mimeType,
      size: data.length,
    };
  }

  async linkExecution(ids: string[], executionId: string): Promise<void> {
    if (ids.length > 0) await this.files.update(ids, { executionId });
  }

  async read(workspaceId: string, id: string): Promise<Buffer> {
    const { body } = await this.open(workspaceId, id);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** For the download endpoint (scoped to the caller's workspace). */
  async download(
    workspaceId: string,
    id: string,
  ): Promise<{ file: BinaryData; body: Readable }> {
    return this.open(workspaceId, id);
  }

  /** Deletes files whose workflow is gone. Returns how many were removed. */
  async deleteOrphans(graceMs = ORPHAN_GRACE_MS): Promise<number> {
    return this.deleteWhere({
      workflowId: IsNull(),
      createdAt: LessThan(new Date(Date.now() - graceMs)),
    });
  }

  /** Files produced by (or uploaded for) the given executions. */
  deleteForExecutions(executionIds: string[]): Promise<number> {
    return executionIds.length
      ? this.deleteWhere({ executionId: In(executionIds) })
      : Promise.resolve(0);
  }

  /** Webhook uploads whose execution was never created (e.g. the start failed). */
  deleteUnlinkedBefore(cutoff: Date): Promise<number> {
    return this.deleteWhere({
      executionId: IsNull(),
      createdAt: LessThan(cutoff),
    });
  }

  private async deleteWhere(
    where: FindOptionsWhere<BinaryData>,
  ): Promise<number> {
    let removed = 0;
    for (;;) {
      const batch = await this.files.find({
        select: { id: true, storageKey: true },
        where,
        take: CLEANUP_BATCH,
      });
      if (batch.length === 0) return removed;
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((f) => ({ Key: f.storageKey })),
            Quiet: true,
          },
        }),
      );
      await this.files.delete(batch.map((f) => f.id));
      removed += batch.length;
    }
  }

  private async open(workspaceId: string, id: string) {
    const file = await this.files.findOneBy({ id, workspaceId });
    if (!file) throw new NotFoundException(`Binary data ${id} not found`);
    const object = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: file.storageKey }),
    );
    return { file, body: object.Body as Readable };
  }
}
