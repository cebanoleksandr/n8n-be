import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { WORKFLOW_QUEUE } from '../src/queue/queue.js';
import {
  createTestApp,
  eventually,
  link,
  testNode,
  type TestApp,
} from './test-app.js';

describe('Triggers (e2e)', () => {
  let t: TestApp;
  let queue: Queue;

  beforeAll(async () => {
    t = await createTestApp();
    queue = t.app.get<Queue>(getQueueToken(WORKFLOW_QUEUE));
  });

  afterAll(() => t.close());

  const webhookGraph = (path: string, responseMode = 'onReceived') => ({
    nodes: [
      testNode('hook', 'core.webhook', { path, method: 'POST', responseMode }),
      testNode('set', 'core.set', {
        assignments: [
          {
            name: 'reply',
            type: 'string',
            value: 'Hello {{ $json.body.name }} via {{ $json.query.src }}',
          },
        ],
        keepOtherFields: false,
      }),
    ],
    connections: [link('hook', 'set')],
  });

  const activate = (id: string, active = true) =>
    t.api().put(`/api/workflows/${id}`).send({ active });

  describe('webhook', () => {
    it('is only reachable while the workflow is active', async () => {
      const path = `orders/${randomUUID()}`;
      const id = await t.createWorkflow('Hook', webhookGraph(path));

      await t.api().post(`/webhook/${path}`).send({}).expect(404);
      await activate(id).expect(200);

      const res = await t
        .api()
        .post(`/webhook/${path}?src=test`)
        .send({ name: 'Ann' })
        .expect(202);
      const execution = await eventually(async () => {
        const r = await t.api().get(`/api/executions/${res.body.executionId}`);
        return r.body.status === 'success' ? r.body : undefined;
      });
      expect(execution.mode).toBe('webhook');
      expect(execution.steps[0].output[0][0].json).toMatchObject({
        method: 'POST',
        path,
        body: { name: 'Ann' },
        query: { src: 'test' },
      });
      expect(execution.steps[1].output[0][0].json).toEqual({
        reply: 'Hello Ann via test',
      });

      // Wrong method, then deactivation.
      await t.api().get(`/webhook/${path}`).expect(404);
      await activate(id, false).expect(200);
      await t.api().post(`/webhook/${path}`).send({}).expect(404);
    });

    it('responds with the last node output in lastNode mode', async () => {
      const path = `sync-${randomUUID()}`;
      const id = await t.createWorkflow(
        'Sync hook',
        webhookGraph(path, 'lastNode'),
      );
      await activate(id).expect(200);

      const res = await t
        .api()
        .post(`/webhook/${path}?src=api`)
        .send({ name: 'Bob' })
        .expect(200);
      expect(res.body).toEqual({ reply: 'Hello Bob via api' });
    });

    it('re-registers the path when an active workflow is saved', async () => {
      const oldPath = `old-${randomUUID()}`;
      const newPath = `new-${randomUUID()}`;
      const id = await t.createWorkflow('Moving hook', webhookGraph(oldPath));
      await activate(id).expect(200);

      await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ graph: webhookGraph(newPath) })
        .expect(200);
      await t.api().post(`/webhook/${oldPath}`).send({}).expect(404);
      await t.api().post(`/webhook/${newPath}`).send({}).expect(202);
    });

    it('rejects a path taken by another active workflow', async () => {
      const path = `taken-${randomUUID()}`;
      const first = await t.createWorkflow('First', webhookGraph(path));
      const second = await t.createWorkflow('Second', webhookGraph(path));
      await activate(first).expect(200);

      const res = await activate(second).expect(409);
      expect(res.body.webhooks).toEqual([`POST /webhook/${path}`]);
      const after = await t.api().get(`/api/workflows/${second}`).expect(200);
      expect(after.body.active).toBe(false);
    });
  });

  describe('activation validation', () => {
    it('requires an activatable trigger', async () => {
      const id = await t.createWorkflow('Manual only', {
        nodes: [testNode('t', 'core.manualTrigger')],
        connections: [],
      });
      const res = await activate(id).expect(400);
      expect(res.body.message).toContain('no trigger that can be activated');
    });

    it('rejects invalid cron, timezone and webhook path', async () => {
      const id = await t.createWorkflow('Broken triggers', {
        nodes: [
          testNode('s1', 'core.schedule', { cron: 'not a cron' }),
          testNode('s2', 'core.schedule', {
            cron: '* * * * *',
            timezone: 'Mars/Base',
          }),
          testNode('w', 'core.webhook', { path: 'bad path!' }),
        ],
        connections: [],
      });
      const res = await activate(id).expect(400);
      expect(res.body.issues.map((i: { nodeId: string }) => i.nodeId)).toEqual([
        's1',
        's2',
        'w',
      ]);
    });
  });

  describe('schedule', () => {
    const schedulerIds = async (workflowId: string) =>
      (await queue.getJobSchedulers(0, -1))
        .map((s) => s.key)
        .filter((key) => key.includes(workflowId));

    it('runs on the cron schedule while active', async () => {
      const id = await t.createWorkflow('Every second', {
        nodes: [testNode('tick', 'core.schedule', { cron: '* * * * * *' })],
        connections: [],
      });
      await activate(id).expect(200);
      expect(await schedulerIds(id)).toEqual([`schedule:${id}:tick`]);

      const execution = await eventually(async () => {
        const r = await t
          .api()
          .get(`/api/executions?workflowId=${id}&status=success`);
        return r.body.items[0] as { id: string; mode: string } | undefined;
      });
      expect(execution.mode).toBe('schedule');
      const details = await t.api().get(`/api/executions/${execution.id}`);
      expect(details.body.steps[0].output[0][0].json.timestamp).toEqual(
        expect.any(String),
      );

      await activate(id, false).expect(200);
      expect(await schedulerIds(id)).toEqual([]);
    });

    it('removes schedulers when the workflow is deleted', async () => {
      const res = await t
        .api()
        .post('/api/workflows')
        .send({
          name: 'Deleted',
          graph: {
            nodes: [testNode('tick', 'core.schedule', { cron: '0 0 1 1 *' })],
            connections: [],
          },
        })
        .expect(201);
      const id = res.body.id as string;
      await activate(id).expect(200);
      expect(await schedulerIds(id)).toHaveLength(1);

      await t.api().delete(`/api/workflows/${id}`).expect(204);
      expect(await schedulerIds(id)).toEqual([]);
    });
  });
});
