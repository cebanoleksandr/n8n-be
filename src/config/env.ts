import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const APP_ROLES = ['all', 'api', 'worker'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  DB_MIGRATIONS_RUN: booleanString.default(true),
  DB_LOGGING: booleanString.default(false),
  /** api: HTTP + WebSocket only; worker: executes queued runs; all: both (dev). */
  APP_ROLE: z.enum(APP_ROLES).default('all'),
  REDIS_URL: z.url().default('redis://localhost:6390'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  /** 32 random bytes, base64. Generate with `openssl rand -base64 32`. */
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'must be 32 bytes encoded as base64 (openssl rand -base64 32)',
    ),
  EXECUTION_TIMEOUT_MAX_SECONDS: z.coerce.number().int().min(1).default(3600),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('flow-binary-data'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanString.default(true),
  BINARY_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  /** Signs access tokens. At least 32 random characters: openssl rand -base64 48 */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
