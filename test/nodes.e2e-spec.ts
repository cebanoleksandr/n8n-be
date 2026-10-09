import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { resumeJobId, WORKFLOW_QUEUE } from '../src/queue/queue.js';
import { startMockServer } from './mock-server.js';
import {
  createTestApp,
  eventually,
  link,
  testNode,
  type TestApp,
} from './test-app.js';

describe('Flow nodes on the worker (e2e)', () => {
  let t: TestApp;
  let mock: Awaited<ReturnType<typeof startMockServer>>;
  let queue: Queue;

  beforeAll(async () => {
    t = await createTestApp();
    mock = await startMockServer();
    queue = t.app.get<Queue>(getQueueToken(WORKFLOW_QUEUE));
  });

  afterAll(async () => {
    await mock.close();
    await t.close();
  });

  const run = (id: string, body: object = {}) =>
    t.api().post(`/api/workflows/${id}/run?wait=true`).send(body);
  const execution = async (id: string) =>
    (await t.api().get(`/api/executions/${id}`).expect(200)).body;

  describe('Execute Workflow', () => {
    /** Child: doubles $json.n */
    const createChild = () =>
      t.createWorkflow('Child', {
        nodes: [
          testNode('in', 'core.executeWorkflowTrigger'),
          testNode('double', 'core.set', {
            assignments: [
              { name: 'n', type: 'number', value: '{{ $json.n * 2 }}' },
              { name: 'batch', type: 'number', value: '{{ $itemIndex }}' },
            ],
          }),
        ],
        connections: [link('in', 'double')],
      });

    const parentGraph = (childId: string, params: Record<string, unknown>) => ({
      nodes: [
        testNode('t', 'core.manualTrigger'),
        testNode('call', 'core.executeWorkflow', {
          workflowId: childId,
          ...params,
        }),
      ],
      connections: [link('t', 'call')],
    });

    const input = [{ n: 1 }, { n: 2 }, { n: 3 }];

    it('runs a sub-workflow and returns its output', async () => {
      const child = await createChild();
      const parent = await t.createWorkflow('Parent', parentGraph(child, {}));
      const res = await run(parent, { input }).expect(200);
      expect(res.body.status).toBe('success');
      expect(
        res.body.steps[1].output[0].map(
          (i: { json: { n: number } }) => i.json.n,
        ),
      ).toEqual([2, 4, 6]);

      const children = await t
        .api()
        .get(`/api/executions?workflowId=${child}`)
        .expect(200);
      expect(children.body.items).toHaveLength(1);
      expect(children.body.items[0]).toMatchObject({
        mode: 'subworkflow',
        parentExecutionId: res.body.id,
      });
    });

    it('loops over batches', async () => {
      const child = await createChild();
      const parent = await t.createWorkflow(
        'Batches',
        parentGraph(child, { mode: 'batches', batchSize: 2 }),
      );
      const res = await run(parent, { input }).expect(200);
      // $itemIndex restarts per batch: two sub-runs of 2 and 1 items.
      expect(
        res.body.steps[1].output[0].map(
          (i: { json: { batch: number } }) => i.json.batch,
        ),
      ).toEqual([0, 1, 0]);
      const children = await t
        .api()
        .get(`/api/executions?workflowId=${child}`)
        .expect(200);
      expect(children.body.total).toBe(2);
    });

    it('starts without waiting and passes items through', async () => {
      const child = await createChild();
      const parent = await t.createWorkflow(
        'Fire and forget',
        parentGraph(child, { waitForCompletion: false }),
      );
      const res = await run(parent, { input: [{ n: 5 }] }).expect(200);
      expect(res.body.steps[1].output[0][0].json).toEqual({ n: 5 });
      await eventually(async () => {
        const r = await t
          .api()
          .get(`/api/executions?workflowId=${child}&status=success`);
        return r.body.total === 1 ? true : undefined;
      });
    });

    it('reports a missing trigger and limits recursion', async () => {
      const plain = await t.createWorkflow('No trigger', {
        nodes: [testNode('t', 'core.manualTrigger')],
        connections: [],
      });
      const parent = await t.createWorkflow('Bad call', parentGraph(plain, {}));
      const res = await run(parent).expect(200);
      expect(res.body.error.message).toContain(
        'has no Execute Workflow Trigger',
      );

      // A workflow that calls itself stops at the depth limit.
      const selfId = await t.createWorkflow('Recursive', {
        nodes: [testNode('in', 'core.executeWorkflowTrigger')],
        connections: [],
      });
      await t
        .api()
        .put(`/api/workflows/${selfId}`)
        .send({
          graph: {
            nodes: [
              testNode('in', 'core.executeWorkflowTrigger'),
              testNode('t', 'core.manualTrigger'),
              testNode('call', 'core.executeWorkflow', { workflowId: selfId }),
            ],
            connections: [link('in', 'call'), link('t', 'call')],
          },
        })
        .expect(200);
      const recursive = await run(selfId, { startNodeId: 't' }).expect(200);
      expect(recursive.body.status).toBe('error');
      expect(JSON.stringify(recursive.body.error)).toContain(
        'at most 10 levels',
      );
    });

    it('cancels the sub-workflow together with the caller', async () => {
      const slowChild = await t.createWorkflow('Slow child', {
        nodes: [
          testNode('in', 'core.executeWorkflowTrigger'),
          testNode('slow', 'core.httpRequest', {
            url: `${mock.url}/slow?ms=20000`,
          }),
        ],
        connections: [link('in', 'slow')],
      });
      const parent = await t.createWorkflow(
        'Cancel parent',
        parentGraph(slowChild, {}),
      );
      const queued = await t
        .api()
        .post(`/api/workflows/${parent}/run`)
        .expect(202);
      const child = await eventually(async () => {
        const r = await t
          .api()
          .get(`/api/executions?workflowId=${slowChild}&status=running`);
        return r.body.items[0] as { id: string } | undefined;
      });

      await t
        .api()
        .post(`/api/executions/${queued.body.id}/cancel`)
        .expect(200);
      await eventually(async () =>
        (await execution(child.id)).status === 'canceled' ? true : undefined,
      );
    });
  });

  describe('Wait', () => {
    const waitGraph = (params: Record<string, unknown>) => ({
      nodes: [
        testNode('t', 'core.manualTrigger'),
        testNode('wait', 'core.wait', params),
        testNode('after', 'core.set', {
          assignments: [{ name: 'done', type: 'boolean', value: 'true' }],
        }),
      ],
      connections: [link('t', 'wait'), link('wait', 'after')],
    });

    it('sleeps in the worker for short waits', async () => {
      const id = await t.createWorkflow(
        'Short wait',
        waitGraph({ amount: 1, unit: 'seconds' }),
      );
      const started = Date.now();
      const res = await run(id).expect(200);
      expect(res.body.status).toBe('success');
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });

    it('pauses long waits and resumes from the saved state', async () => {
      const id = await t.createWorkflow(
        'Long wait',
        waitGraph({ amount: 2, unit: 'hours' }),
      );
      const res = await run(id, { input: [{ x: 1 }] }).expect(200);
      expect(res.body.status).toBe('waiting');
      expect(new Date(res.body.waitTill).getTime()).toBeGreaterThan(
        Date.now() + 3_500_000,
      );
      expect(res.body.steps.map((s: { nodeId: string }) => s.nodeId)).toEqual([
        't',
      ]);

      // Fast-forward: run the delayed resume job now.
      const job = await queue.getJob(resumeJobId(res.body.id));
      expect(await job!.getState()).toBe('delayed');
      await job!.promote();

      const done = await eventually(async () => {
        const e = await execution(res.body.id);
        return e.status === 'success' ? e : undefined;
      });
      expect(done.steps.map((s: { nodeId: string }) => s.nodeId)).toEqual([
        't',
        'wait',
        'after',
      ]);
      expect(done.steps[2].output[0][0].json).toEqual({ x: 1, done: true });
      expect(done.waitTill).toBeNull();
    });

    it('cancels a waiting execution', async () => {
      const id = await t.createWorkflow(
        'Cancel wait',
        waitGraph({ amount: 1, unit: 'days' }),
      );
      const res = await run(id).expect(200);
      expect(res.body.status).toBe('waiting');
      const canceled = await t
        .api()
        .post(`/api/executions/${res.body.id}/cancel`)
        .expect(200);
      expect(canceled.body.status).toBe('canceled');
      expect(await queue.getJob(resumeJobId(res.body.id))).toBeUndefined();
    });
  });

  describe('Respond to Webhook', () => {
    const respondGraph = (path: string, respond: Record<string, unknown>) => ({
      nodes: [
        testNode('hook', 'core.webhook', {
          path,
          responseMode: 'responseNode',
        }),
        testNode('respond', 'core.respondToWebhook', respond),
        testNode('after', 'core.set'),
      ],
      connections: [link('hook', 'respond'), link('respond', 'after')],
    });

    const activate = async (graph: object) => {
      const id = await t.createWorkflow('Responder', graph);
      await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ active: true })
        .expect(200);
      return id;
    };

    it('answers with status, headers and JSON from the node', async () => {
      const path = `respond-${randomUUID()}`;
      await activate(
        respondGraph(path, {
          respondWith: 'json',
          responseBody: '{"created": true, "name": "{{ $json.body.name }}"}',
          statusCode: 201,
          headers: [{ name: 'X-Flow', value: 'yes' }],
        }),
      );
      const res = await t
        .anon()
        .post(`/webhook/${path}`)
        .send({ name: 'Ann' })
        .expect(201);
      expect(res.headers['x-flow']).toBe('yes');
      expect(res.body).toEqual({ created: true, name: 'Ann' });
    });

    it('can answer with text or a file', async () => {
      const textPath = `text-${randomUUID()}`;
      await activate(
        respondGraph(textPath, {
          respondWith: 'text',
          responseBody: 'hello {{ $json.query.who }}',
        }),
      );
      const text = await t.anon().get(`/webhook/${textPath}?who=you`);
      // GET is not the default method of the Webhook node.
      expect(text.status).toBe(404);
      const posted = await t
        .anon()
        .post(`/webhook/${textPath}?who=you`)
        .expect(200);
      expect(posted.text).toBe('hello you');
      expect(posted.headers['content-type']).toContain('text/plain');

      const filePath = `file-${randomUUID()}`;
      await activate({
        nodes: [
          testNode('hook', 'core.webhook', {
            path: filePath,
            responseMode: 'responseNode',
          }),
          testNode('get', 'core.httpRequest', {
            url: `${mock.url}/file`,
            responseFormat: 'file',
          }),
          testNode('respond', 'core.respondToWebhook', {
            respondWith: 'binary',
          }),
        ],
        connections: [link('hook', 'get'), link('get', 'respond')],
      });
      const file = await t
        .anon()
        .post(`/webhook/${filePath}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.body).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    });

    it('reports a workflow that never responds', async () => {
      const path = `silent-${randomUUID()}`;
      await activate({
        nodes: [
          testNode('hook', 'core.webhook', {
            path,
            responseMode: 'responseNode',
          }),
          testNode('set', 'core.set'),
        ],
        connections: [link('hook', 'set')],
      });
      const res = await t.anon().post(`/webhook/${path}`).send({}).expect(500);
      expect(res.body.message).toContain(
        'without reaching a Respond to Webhook node',
      );
    });
  });
});
