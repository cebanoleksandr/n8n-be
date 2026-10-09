import type { DataSourceOptions } from 'typeorm';
import { RefreshToken } from '../modules/auth/refresh-token.entity.js';
import { User } from '../modules/auth/user.entity.js';
import { BinaryData } from '../modules/binary-data/binary-data.entity.js';
import { Credential } from '../modules/credentials/credential.entity.js';
import { ExecutionStep } from '../modules/executions/execution-step.entity.js';
import { Execution } from '../modules/executions/execution.entity.js';
import { Webhook } from '../modules/triggers/webhook.entity.js';
import { WorkflowVersion } from '../modules/workflows/workflow-version.entity.js';
import { Workflow } from '../modules/workflows/workflow.entity.js';
import { Invitation } from '../modules/workspaces/invitation.entity.js';
import { WorkspaceMember } from '../modules/workspaces/workspace-member.entity.js';
import { Workspace } from '../modules/workspaces/workspace.entity.js';
import { migrations } from './migrations/index.js';

// Entities and migrations are listed explicitly: glob paths are unreliable under ESM.
export const entities = [
  Workspace,
  Workflow,
  WorkflowVersion,
  Execution,
  ExecutionStep,
  Credential,
  Webhook,
  BinaryData,
  User,
  WorkspaceMember,
  RefreshToken,
  Invitation,
];

export function dataSourceOptions(env: {
  DATABASE_URL: string;
  DB_MIGRATIONS_RUN: boolean;
  DB_LOGGING: boolean;
}): DataSourceOptions {
  return {
    type: 'postgres',
    url: env.DATABASE_URL,
    // gen_random_uuid() is built into Postgres 13+, no uuid-ossp needed.
    uuidExtension: 'pgcrypto',
    entities,
    migrations,
    migrationsRun: env.DB_MIGRATIONS_RUN,
    synchronize: false,
    logging: env.DB_LOGGING,
  };
}
