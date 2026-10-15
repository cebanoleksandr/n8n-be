import type { ConfigService } from '@nestjs/config';
import type { Env } from './env.js';

/** Where users and other services reach this server, without a trailing slash. */
export function publicUrlOf(config: ConfigService<Env, true>): string {
  return (
    config.get('PUBLIC_URL', { infer: true }) ??
    `http://localhost:${config.get('PORT', { infer: true })}`
  ).replace(/\/+$/, '');
}
