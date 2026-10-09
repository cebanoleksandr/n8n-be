import { Redis } from 'ioredis';
import { Client } from 'pg';
import { testEnv } from './test-env.js';

/**
 * Creates the e2e database on first run (tables come from the app's
 * migrations) and empties the test Redis db, so queues and login rate-limit
 * counters do not carry over between runs.
 */
export default async function setup(): Promise<void> {
  const redis = new Redis(testEnv.REDIS_URL);
  await redis.flushdb();
  await redis.quit();

  const url = new URL(testEnv.DATABASE_URL);
  const database = url.pathname.slice(1);
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );
    if (!rowCount)
      await client.query(`CREATE DATABASE "${database.replace(/"/g, '')}"`);
  } finally {
    await client.end();
  }
}
