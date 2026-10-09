import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { WorkflowNode } from '../src/engine/types.js';

/**
 * Full app (API + worker in one process) listening on a random port.
 * Requires Postgres and Redis from docker-compose and a .env file.
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

  return {
    app,
    url: url.replace('[::1]', '127.0.0.1'),
    api: () => request(app.getHttpServer()),
    /** Creates a workflow that is deleted in close(). */
    async createWorkflow(name: string, graph?: unknown): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/api/workflows')
        .send({ name, graph })
        .expect(201);
      created.push(res.body.id);
      return res.body.id as string;
    },
    async close() {
      for (const id of created) {
        await request(app.getHttpServer()).delete(`/api/workflows/${id}`);
      }
      await app.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

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
