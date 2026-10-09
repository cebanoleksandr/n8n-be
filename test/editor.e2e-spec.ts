import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Execution } from '../src/modules/executions/execution.entity.js';
import { BinaryData } from '../src/modules/binary-data/binary-data.entity.js';
import { ExecutionPruner } from '../src/modules/worker/execution-pruner.service.js';
import { startMockServer } from './mock-server.js';
import { createTestApp, link, testNode, type TestApp } from './test-app.js';

describe('Editor features (e2e)', () => {
  let t: TestApp;
  let mock: Awaited<ReturnType<typeof startMockServer>>;

  beforeAll(async () => {
    t = await createTestApp();
    mock = await startMockServer();
  });

  afterAll(async () => {
    await mock.close();
    await t.close();
  });

  /** trigger -> http (counts calls) -> label */
  const httpGraph = (key: string) => ({
    nodes: [
      testNode('trigger', 'core.manualTrigger'),
      testNode('http', 'core.httpRequest', {
        url: `${mock.url}/flaky?key=${key}&n=0`,
      }),
      testNode('label', 'core.set', {
        assignments: [
          {
            name: 'label',
            type: 'string',
            value: 'attempt {{ $json.attempt }}',
          },
        ],
      }),
    ],
    connections: [link('trigger', 'http'), link('http', 'label')],
  });

  const run = (id: string, body: object = {}) =>
    t.api().post(`/api/workflows/${id}/run?wait=true`).send(body);
  const nodeIds = (res: { body: { steps: { nodeId: string }[] } }) =>
    res.body.steps.map((s) => s.nodeId);

  describe('partial runs', () => {
    it('runs up to a destination node', async () => {
      const id = await t.createWorkflow('Partial', httpGraph(randomUUID()));
      const res = await run(id, { destinationNodeId: 'http' }).expect(200);
      expect(res.body.status).toBe('success');
      expect(nodeIds(res)).toEqual(['trigger', 'http']);
    });

    it('re-runs from a node without repeating upstream calls', async () => {
      const id = await t.createWorkflow('Rerun', httpGraph(randomUUID()));
      const first = await run(id).expect(200);
      expect(first.body.steps[2].output[0][0].json.label).toBe('attempt 1');

      // Only "label" runs; it reuses the HTTP output of the first run.
      const second = await run(id, { runFromNodeId: 'label' }).expect(200);
      expect(nodeIds(second)).toEqual(['label']);
      expect(second.body.steps[0].output[0][0].json.label).toBe('attempt 1');

      // Chained partial runs still find the HTTP output two runs back.
      const third = await run(id, { runFromNodeId: 'label' }).expect(200);
      expect(third.body.status).toBe('success');
      expect(third.body.steps[0].output[0][0].json.label).toBe('attempt 1');

      // Running from "http" calls the API again.
      const fourth = await run(id, { runFromNodeId: 'http' }).expect(200);
      expect(fourth.body.steps.at(-1).output[0][0].json.label).toBe(
        'attempt 2',
      );
    });

    it('needs an earlier execution to run from', async () => {
      const id = await t.createWorkflow('Fresh', httpGraph(randomUUID()));
      const res = await t
        .api()
        .post(`/api/workflows/${id}/run`)
        .send({ runFromNodeId: 'label' })
        .expect(400);
      expect(res.body.message).toContain('No earlier execution');
    });
  });

  describe('pinned data', () => {
    it('replaces node execution in manual runs only', async () => {
      const id = await t.createWorkflow('Pinned', httpGraph(randomUUID()));
      const saved = await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ pinData: { http: [{ attempt: 99 }] } })
        .expect(200);
      expect(saved.body.pinData).toEqual({ http: [{ attempt: 99 }] });

      const res = await run(id).expect(200);
      expect(res.body.steps[1]).toMatchObject({
        nodeId: 'http',
        pinned: true,
        tries: 0,
      });
      expect(res.body.steps[2].output[0][0].json.label).toBe('attempt 99');

      await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ pinData: {} })
        .expect(200);
      const unpinned = await run(id).expect(200);
      expect(unpinned.body.steps[1].pinned).toBe(false);
    });

    it('rejects oversized pinned data', async () => {
      const id = await t.createWorkflow('Big pin', httpGraph(randomUUID()));
      const items = Array.from({ length: 1001 }, () => ({}));
      await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ pinData: { http: items } })
        .expect(400);
    });
  });

  describe('test webhooks', () => {
    const hookGraph = (path: string) => ({
      nodes: [
        testNode('hook', 'core.webhook', { path, responseMode: 'lastNode' }),
        testNode('set', 'core.set', {
          assignments: [
            { name: 'got', type: 'string', value: '{{ $json.body.x }}' },
          ],
          keepOtherFields: false,
        }),
      ],
      connections: [link('hook', 'set')],
    });

    it('accepts one request while listening, without activation', async () => {
      const path = `test-${randomUUID()}`;
      const id = await t.createWorkflow('Test hook', hookGraph(path));

      await t.anon().post(`/webhook-test/${path}`).send({ x: 1 }).expect(404);

      const listen = await t
        .api()
        .post(`/api/workflows/${id}/test-webhook`)
        .expect(200);
      expect(listen.body).toEqual({
        webhooks: [{ nodeId: 'hook', method: 'POST', path }],
        expiresInSeconds: 120,
      });

      const res = await t
        .anon()
        .post(`/webhook-test/${path}`)
        .send({ x: 'hello' })
        .expect(200);
      expect(res.body).toEqual({ got: 'hello' });

      // Single use, and production URL stays closed (workflow is inactive).
      await t.anon().post(`/webhook-test/${path}`).send({ x: 2 }).expect(404);
      await t.anon().post(`/webhook/${path}`).send({ x: 2 }).expect(404);

      const executions = await t
        .api()
        .get(`/api/executions?workflowId=${id}`)
        .expect(200);
      expect(executions.body.items[0].mode).toBe('manual');
    });

    it('can stop listening', async () => {
      const path = `stop-${randomUUID()}`;
      const id = await t.createWorkflow('Stop hook', hookGraph(path));
      await t.api().post(`/api/workflows/${id}/test-webhook`).expect(200);
      await t.api().delete(`/api/workflows/${id}/test-webhook`).expect(204);
      await t.anon().post(`/webhook-test/${path}`).send({}).expect(404);
    });

    it('requires a webhook node', async () => {
      const id = await t.createWorkflow('No hook', httpGraph(randomUUID()));
      await t.api().post(`/api/workflows/${id}/test-webhook`).expect(400);
    });
  });

  describe('versions, export and import', () => {
    it('restores an old version as a new one', async () => {
      const id = await t.createWorkflow('Versioned', httpGraph('v1'));
      await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ graph: httpGraph('v2') })
        .expect(200);
      const versions = await t
        .api()
        .get(`/api/workflows/${id}/versions`)
        .expect(200);
      const v1 = versions.body.find(
        (v: { version: number }) => v.version === 1,
      );

      const old = await t
        .api()
        .get(`/api/workflows/${id}/versions/${v1.id}`)
        .expect(200);
      expect(old.body.graph.nodes[1].parameters.url).toContain('key=v1');

      const restored = await t
        .api()
        .post(`/api/workflows/${id}/versions/${v1.id}/restore`)
        .expect(200);
      expect(restored.body.version).toBe(3);
      expect(restored.body.graph.nodes[1].parameters.url).toContain('key=v1');
    });

    it('round-trips a workflow and drops unknown credentials', async () => {
      const credential = await t
        .api()
        .post('/api/credentials')
        .send({ name: 'Token', type: 'httpBearerAuth', data: { token: 't' } })
        .expect(201);
      const graph = httpGraph('export');
      graph.nodes[1].credentials = { httpBearerAuth: credential.body.id };
      const id = await t.createWorkflow('Exported', graph);
      await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({
          settings: { timeoutSeconds: 30 },
          pinData: { trigger: [{ a: 1 }] },
        })
        .expect(200);

      const exported = await t
        .api()
        .get(`/api/workflows/${id}/export`)
        .expect(200);
      expect(exported.body).toMatchObject({
        format: 'flow-workflow@1',
        name: 'Exported',
        settings: { timeoutSeconds: 30 },
        pinData: { trigger: [{ a: 1 }] },
      });

      const imported = await t
        .api()
        .post('/api/workflows/import')
        .send({ ...exported.body, name: 'Imported' })
        .expect(201);
      expect(imported.body.graph.nodes[1].credentials).toEqual({
        httpBearerAuth: credential.body.id,
      });
      expect(imported.body.settings).toEqual({ timeoutSeconds: 30 });

      // In a workspace without that credential the reference is dropped.
      const foreign = structuredClone(exported.body);
      foreign.graph.nodes[1].credentials = { httpBearerAuth: randomUUID() };
      const stripped = await t
        .api()
        .post('/api/workflows/import')
        .send(foreign)
        .expect(201);
      expect(stripped.body.graph.nodes[1].credentials).toEqual({});

      for (const w of [imported.body.id, stripped.body.id]) {
        await t.api().delete(`/api/workflows/${w}`).expect(204);
      }
      await t
        .api()
        .delete(`/api/credentials/${credential.body.id}`)
        .expect(204);
    });
  });

  describe('execution pruning', () => {
    it('deletes old executions with their steps and files', async () => {
      const id = await t.createWorkflow('Prunable', {
        nodes: [
          testNode('trigger', 'core.manualTrigger'),
          testNode('get', 'core.httpRequest', {
            url: `${mock.url}/file`,
            responseFormat: 'file',
          }),
        ],
        connections: [link('trigger', 'get')],
      });
      const old = await run(id).expect(200);
      const recent = await run(id).expect(200);
      const db = t.app.get(DataSource);
      await db.getRepository(Execution).update(old.body.id, {
        finishedAt: new Date(Date.now() - 30 * 86_400_000),
      });

      expect(await t.app.get(ExecutionPruner).prune(14)).toBeGreaterThanOrEqual(
        1,
      );

      await t.api().get(`/api/executions/${old.body.id}`).expect(404);
      await t.api().get(`/api/executions/${recent.body.id}`).expect(200);
      const oldFile = old.body.steps[1].output[0][0].binary.data.id;
      expect(await db.getRepository(BinaryData).existsBy({ id: oldFile })).toBe(
        false,
      );
      await t.api().get(`/api/binary-data/${oldFile}`).expect(404);
    });
  });

  describe('health', () => {
    it('reports liveness and readiness', async () => {
      await t.anon().get('/api/health').expect(200, { status: 'ok' });
      const ready = await t.anon().get('/api/health/ready').expect(200);
      expect(ready.body.checks).toEqual({
        database: 'ok',
        redis: 'ok',
        storage: 'ok',
      });
    });
  });
});
