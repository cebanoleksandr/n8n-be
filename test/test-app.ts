import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { WorkflowNode } from '../src/engine/types.js';
import { hashPassword } from '../src/modules/auth/password.js';
import type { Role } from '../src/modules/auth/roles.js';
import { TokensService } from '../src/modules/auth/tokens.service.js';
import { User } from '../src/modules/auth/user.entity.js';
import { DEFAULT_WORKSPACE_ID } from '../src/modules/workspaces/default-workspace.js';
import { WorkspaceMember } from '../src/modules/workspaces/workspace-member.entity.js';

export const TEST_PASSWORD = 'test-password-123';

/** supertest with a bearer token on every request. */
export function client(server: App, token?: string) {
  const send =
    (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => (url: string) => {
      const req = request(server)[method](url);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
  return {
    get: send('get'),
    post: send('post'),
    put: send('put'),
    patch: send('patch'),
    delete: send('delete'),
  };
}

/**
 * Full app (API + worker in one process) listening on a random port, plus an
 * owner of the default workspace whose token `api()` sends.
 * Requires docker compose services and a .env file (see vitest.config.e2e.ts).
 */
export async function createTestApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRole('all')],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  const created: string[] = [];
  const server = app.getHttpServer() as App;
  const owner = await createUser(app, 'owner');

  return {
    app,
    url: url.replace('[::1]', '127.0.0.1'),
    owner,
    /** Requests as the workspace owner. */
    api: () => client(server, owner.token),
    /** Requests without a token. */
    anon: () => client(server),
    /** Requests as a user with the given token. */
    as: (token: string) => client(server, token),
    createUser: (role: Role) => createUser(app, role),
    /** Creates a workflow that is deleted in close(). */
    async createWorkflow(name: string, graph?: unknown): Promise<string> {
      const res = await client(server, owner.token)
        .post('/api/workflows')
        .send({ name, graph })
        .expect(201);
      created.push(res.body.id);
      return res.body.id as string;
    },
    async close() {
      for (const id of created) {
        await client(server, owner.token).delete(`/api/workflows/${id}`);
      }
      await app.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Creates a user that is a member of the default workspace with `role`. */
async function createUser(app: NestExpressApplication, role: Role) {
  const db = app.get(DataSource);
  const email = `${role}-${randomUUID()}@test.local`;
  const user = await db.getRepository(User).save({
    email,
    name: `Test ${role}`,
    passwordHash: await hashPassword(TEST_PASSWORD),
  });
  await db.getRepository(WorkspaceMember).insert({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: user.id,
    role,
  });
  return {
    id: user.id,
    email,
    token: app.get(TokensService).signAccess(user.id),
  };
}

export function testNode(
  id: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    name: id,
    type,
    typeVersion: 1,
    position: [0, 0],
    parameters,
    ...extra,
  };
}

export function link(from: string, to: string, fromIndex = 0) {
  return {
    from: { nodeId: from, index: fromIndex },
    to: { nodeId: to, index: 0 },
  };
}

/** Polls until `check` returns a value or the timeout passes. */
export async function eventually<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}
