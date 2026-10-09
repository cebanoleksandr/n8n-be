import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import type { Env } from '../../config/env.js';
import { BinaryDataService } from '../binary-data/binary-data.service.js';
import { Execution } from '../executions/execution.entity.js';

const BATCH = 500;

/** Deletes old finished executions with their steps (FK cascade) and files. */
@Injectable()
export class ExecutionPruner {
  constructor(
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
    private readonly binaryData: BinaryDataService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Returns the number of executions deleted. */
  async prune(
    maxAgeDays = this.config.get('EXECUTIONS_MAX_AGE_DAYS', { infer: true }),
  ) {
    if (maxAgeDays <= 0) return 0;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (;;) {
      const batch = await this.executions.find({
        select: { id: true },
        where: {
          finishedAt: LessThan(cutoff),
          status: In(['success', 'error', 'canceled']),
        },
        take: BATCH,
      });
      if (batch.length === 0) break;
      const ids = batch.map((e) => e.id);
      await this.binaryData.deleteForExecutions(ids);
      await this.executions.delete(ids);
      deleted += ids.length;
    }
    await this.binaryData.deleteUnlinkedBefore(cutoff);
    return deleted;
  }
}
