import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { EventEmitter } from 'node:events';
import type { Env } from '../../config/env.js';
import { redisOptionsFromUrl } from '../../redis/redis-options.js';
import type { ExecutionEvent } from './execution-events.js';

const CHANNEL = 'flow:execution-events';

/**
 * Cross-process execution events. Workers publish; API processes subscribe.
 * Redis connections are opened lazily, so a worker never opens a subscriber.
 */
@Injectable()
export class ExecutionEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutionEventsService.name);
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  private publisher?: Redis;
  private subscriber?: Redis;
  private subscribed?: Promise<unknown>;

  constructor(private readonly config: ConfigService<Env, true>) {}

  async publish(event: ExecutionEvent): Promise<void> {
    this.publisher ??= new Redis({
      ...this.redisOptions(),
      maxRetriesPerRequest: 3,
    });
    try {
      await this.publisher.publish(CHANNEL, JSON.stringify(event));
    } catch (err) {
      // Progress events are best-effort; the execution itself must not fail.
      this.logger.warn(
        `Failed to publish ${event.type}: ${(err as Error).message}`,
      );
    }
  }

  /** Resolves once the Redis subscription is active. Returns an unsubscribe function. */
  async subscribe(
    listener: (event: ExecutionEvent) => void,
  ): Promise<() => void> {
    if (!this.subscribed) {
      this.subscriber = new Redis(this.redisOptions());
      this.subscriber.on('message', (_channel: string, message: string) => {
        try {
          this.emitter.emit('event', JSON.parse(message) as ExecutionEvent);
        } catch (err) {
          this.logger.warn(`Bad event payload: ${(err as Error).message}`);
        }
      });
      this.subscribed = this.subscriber.subscribe(CHANNEL);
    }
    await this.subscribed;
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  private redisOptions() {
    return redisOptionsFromUrl(this.config.get('REDIS_URL', { infer: true }));
  }
}

@Global()
@Module({
  providers: [ExecutionEventsService],
  exports: [ExecutionEventsService],
})
export class EventsModule {}
