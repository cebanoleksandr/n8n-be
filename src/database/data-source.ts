// Entry point for the TypeORM CLI (`npm run typeorm -- migration:run`). Runs from dist/.
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.js';
import { dataSourceOptions } from './data-source-options.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the real environment.
}

export default new DataSource({
  ...dataSourceOptions(validateEnv(process.env)),
  migrationsRun: false,
});
