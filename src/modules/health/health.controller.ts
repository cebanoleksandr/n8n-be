import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../auth/auth.decorators.js';
import { BinaryDataService } from '../binary-data/binary-data.service.js';
import { ExecutionEventsService } from '../events/execution-events.service.js';

/** 'ok' or 'error: <reason>'. */
type CheckResult = string;

const CHECK_TIMEOUT_MS = 3000;

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly events: ExecutionEventsService,
    private readonly binaryData: BinaryDataService,
  ) {}

  /** Liveness: the process is up. Never depends on other services. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: Postgres, Redis and object storage are reachable (503 otherwise). */
  @Get('ready')
  async ready(): Promise<{
    status: 'ok';
    checks: Record<string, CheckResult>;
  }> {
    const checks = {
      database: await check(() => this.dataSource.query('SELECT 1')),
      redis: await check(() => this.events.ping()),
      storage: await check(() => this.binaryData.ping()),
    };
    if (Object.values(checks).some((c) => c !== 'ok')) {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }
}

async function check(fn: () => Promise<unknown>): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('timed out')),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return 'ok';
  } catch (err) {
    return `error: ${(err as Error).message}`;
  } finally {
    clearTimeout(timer);
  }
}
