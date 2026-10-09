import { randomUUID } from 'node:crypto';
import { startMockServer } from './mock-server.js';
import {
  createTestApp,
  eventually,
  link,
  testNode,
  type TestApp,
} from './test-app.js';

describe('Retries, timeouts, cancel and error workflows (e2e)', () => {
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

  const httpWorkflow = (url: string, httpExtra = {}) => ({
    nodes: [
      testNode('t', 'core.manualTrigger'),
      testNode('http', 'core.httpRequest', { url }, httpExtra),
    ],
    connections: [link('t', 'http')],
  });

  const getExecution = async (id: string) =>
    (await t.api().get(`/api/executions/${id}`).expect(200)).body;

  describe('retries', () => {
    it('records the number of tries of a node that recovered', async () => {
      const id = await t.createWorkflow(
        'Flaky',
        httpWorkflow(`${mock.url}/flaky?key=${randomUUID()}&n=2`, {
          retryOnFail: true,
          maxTries: 3,
          waitBetweenTriesMs: 10,
        }),
      );
      const run = await t
        .api()
        .post(`/api/workflows/${id}/run?wait=true`)
        .expect(200);
      expect(run.body.status).toBe('success');
      expect(run.body.steps[1]).toMatchObject({ status: 'success', tries: 3 });
      expect(run.body.steps[1].output[0][0].json).toEqual({ attempt: 3 });
    });
  });

  describe('timeouts', () => {
    it('fails a run that exceeds the workflow timeout', async () => {
      const id = await t.createWorkflow(
        'Slow',
        httpWorkflow(`${mock.url}/slow?ms=10000`),
      );
      await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ settings: { timeoutSeconds: 1 } })
        .expect(200);

      const started = Date.now();
      const run = await t
        .api()
        .post(`/api/workflows/${id}/run?wait=true`)
        .expect(200);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(run.body).toMatchObject({
        status: 'error',
        error: {
          name: 'ExecutionTimeoutError',
          message: 'Execution timed out after 1s',
          nodeId: 'http',
        },
      });
    });

    it('rejects timeouts above the server maximum', async () => {
      const id = await t.createWorkflow('Too long', httpWorkflow(mock.url));
      const res = await t
        .api()
        .put(`/api/workflows/${id}`)
        .send({ settings: { timeoutSeconds: 10 ** 9 } })
        .expect(400);
      expect(res.body.message).toContain('cannot exceed');
    });
  });

  describe('cancel', () => {
    it('stops a running execution', async () => {
      const id = await t.createWorkflow(
        'Cancel me',
        httpWorkflow(`${mock.url}/slow?ms=20000`),
      );
      const queued = await t.api().post(`/api/workflows/${id}/run`).expect(202);
      await eventually(async () =>
        (await getExecution(queued.body.id)).status === 'running'
          ? true
          : undefined,
      );

      const started = Date.now();
      const canceled = await t
        .api()
        .post(`/api/executions/${queued.body.id}/cancel`)
        .expect(200);
      expect(canceled.body).toMatchObject({
        status: 'canceled',
        error: { name: 'ExecutionCanceledError' },
      });
      // The cancel may land between nodes (HTTP never ran) or mid-request
      // (HTTP recorded as error); either way it must not have completed.
      const http = canceled.body.steps.find(
        (s: { nodeId: string }) => s.nodeId === 'http',
      );
      expect(http?.status ?? 'not run').not.toBe('success');
      expect(Date.now() - started).toBeLessThan(5000);

      await t
        .api()
        .post(`/api/executions/${queued.body.id}/cancel`)
        .expect(409);
    });
  });

  describe('error workflow', () => {
    const errorHandlerGraph = {
      nodes: [
        testNode('err', 'core.errorTrigger'),
        testNode('set', 'core.set', {
          assignments: [
            {
              name: 'summary',
              type: 'string',
              value:
                '{{ $json.workflow.name }} failed at {{ $json.execution.lastNodeExecuted }}',
            },
          ],
        }),
      ],
      connections: [link('err', 'set')],
    };

    it('starts the error workflow when a production run fails', async () => {
      const handler = await t.createWorkflow(
        'Error handler',
        errorHandlerGraph,
      );
      const path = `failing-${randomUUID()}`;
      const failing = await t.createWorkflow('Failing hook', {
        nodes: [
          testNode('hook', 'core.webhook', { path }),
          testNode('http', 'core.httpRequest', { url: `${mock.url}/fail` }),
        ],
        connections: [link('hook', 'http')],
      });
      await t
        .api()
        .put(`/api/workflows/${failing}`)
        .send({ active: true, settings: { errorWorkflowId: handler } })
        .expect(200);

      // A manual run does not trigger the error workflow...
      const manual = await t
        .api()
        .post(`/api/workflows/${failing}/run?wait=true`)
        .expect(200);
      expect(manual.body.status).toBe('error');

      // ...a webhook (production) run does.
      const hook = await t.api().post(`/webhook/${path}`).send({}).expect(202);
      const handled = await eventually(async () => {
        const r = await t
          .api()
          .get(`/api/executions?workflowId=${handler}&status=success`);
        return r.body.items[0] as { id: string; mode: string } | undefined;
      });
      expect(handled.mode).toBe('error');
      const details = await getExecution(handled.id);
      expect(details.steps[0].output[0][0].json).toMatchObject({
        execution: {
          id: hook.body.executionId,
          mode: 'webhook',
          lastNodeExecuted: 'http',
          error: { message: expect.stringContaining('status 500') },
        },
        workflow: { id: failing, name: 'Failing hook' },
      });
      expect(details.steps[1].output[0][0].json.summary).toBe(
        'Failing hook failed at http',
      );
      const all = await t.api().get(`/api/executions?workflowId=${handler}`);
      expect(all.body.total).toBe(1);
    });

    it('validates the error workflow', async () => {
      const plain = await t.createWorkflow(
        'No error trigger',
        httpWorkflow(mock.url),
      );
      const target = await t.createWorkflow('Target', httpWorkflow(mock.url));

      const self = await t
        .api()
        .put(`/api/workflows/${target}`)
        .send({ settings: { errorWorkflowId: target } })
        .expect(400);
      expect(self.body.message).toContain('its own error workflow');

      const noTrigger = await t
        .api()
        .put(`/api/workflows/${target}`)
        .send({ settings: { errorWorkflowId: plain } })
        .expect(400);
      expect(noTrigger.body.message).toContain('has no Error Trigger');

      const handler = await t.createWorkflow('Handler', errorHandlerGraph);
      const set = await t
        .api()
        .put(`/api/workflows/${target}`)
        .send({ settings: { errorWorkflowId: handler, timeoutSeconds: 30 } })
        .expect(200);
      expect(set.body.settings).toEqual({
        errorWorkflowId: handler,
        timeoutSeconds: 30,
      });

      const cleared = await t
        .api()
        .put(`/api/workflows/${target}`)
        .send({ settings: { errorWorkflowId: null } })
        .expect(200);
      expect(cleared.body.settings).toEqual({ timeoutSeconds: 30 });
    });
  });
});
