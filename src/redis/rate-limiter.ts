import type { Redis } from 'ioredis';

/** Fixed-window counter in Redis, shared by all API instances. */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  /** Counts a hit; returns seconds to wait when the limit is exceeded, else 0. */
  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<number> {
    const redisKey = `${this.prefix}:${key}`;
    const [[, count], [, ttl]] = (await this.redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .ttl(redisKey)
      .exec()) as [[null, number], [null, number], [null, number]];
    return count > limit ? Math.max(ttl, 1) : 0;
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}:${key}`);
  }

  /** Called by Nest on shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
