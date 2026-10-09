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

/** Worker -> API: progress of executions. */
const EVENTS_CHANNEL = 'flow:execution-events';
/** API -> workers: stop a running execution (whichever worker has it acts). */
const CANCEL_CHANNEL = 'flow:execution-cancel';

/**
 * Cross-process messaging over Redis pub/sub. Connections are opened lazily,
 * so a process only holds the connections for the channels it uses.
 */
@Injectable()
export class ExecutionEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(ExecutionEventsService.name);
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  private publisher?: Redis;
  private subscriber?: Redis;
  private readonly subscriptions = new Map<string, Promise<unknown>>();

  constructor(private readonly config: ConfigService<Env, true>) {}

  async publish(event: ExecutionEvent): Promise<void> {
    // Progress events are best-effort; the execution itself must not fail.
    await this.send(EVENTS_CHANNEL, event, `event ${event.type}`);
  }

  /** Resolves once the Redis subscription is active. Returns an unsubscribe function. */
  subscribe(listener: (event: ExecutionEvent) => void): Promise<() => void> {
    return this.listen(EVENTS_CHANNEL, listener);
  }

  async requestCancel(executionId: string): Promise<void> {
    await this.send(CANCEL_CHANNEL, { executionId }, 'cancel request');
  }

  onCancelRequest(
    listener: (executionId: string) => void,
  ): Promise<() => void> {
    return this.listen(CANCEL_CHANNEL, (msg: { executionId: string }) =>
      listener(msg.executionId),
    );
  }

  /** Throws when Redis is unreachable (readiness check). */
  async ping(): Promise<void> {
    this.publisher ??= new Redis({
      ...this.redisOptions(),
      maxRetriesPerRequest: 3,
    });
    await this.publisher.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  private async send(channel: string, payload: unknown, what: string) {
    this.publisher ??= new Redis({
      ...this.redisOptions(),
      maxRetriesPerRequest: 3,
    });
    try {
      await this.publisher.publish(channel, JSON.stringify(payload));
    } catch (err) {
      this.logger.warn(`Failed to publish ${what}: ${(err as Error).message}`);
    }
  }

  private async listen<T>(
    channel: string,
    listener: (payload: T) => void,
  ): Promise<() => void> {
    if (!this.subscriber) {
      this.subscriber = new Redis(this.redisOptions());
      this.subscriber.on('message', (ch: string, message: string) => {
        try {
          this.emitter.emit(ch, JSON.parse(message));
        } catch (err) {
          this.logger.warn(`Bad payload on ${ch}: ${(err as Error).message}`);
        }
      });
    }
    let subscribed = this.subscriptions.get(channel);
    if (!subscribed) {
      subscribed = this.subscriber.subscribe(channel);
      this.subscriptions.set(channel, subscribed);
    }
    await subscribed;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
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
