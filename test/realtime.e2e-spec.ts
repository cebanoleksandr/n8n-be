import { io, type Socket } from 'socket.io-client';
import type { ExecutionEvent } from '../src/modules/events/execution-events.js';
import {
  createTestApp,
  eventually,
  link,
  testNode,
  type TestApp,
} from './test-app.js';

describe('Realtime execution events (e2e)', () => {
  let t: TestApp;
  let socket: Socket;

  beforeAll(async () => {
    t = await createTestApp();
    socket = io(`${t.url}/executions`, { transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
  });

  afterAll(async () => {
    socket.close();
    await t.close();
  });

  it('streams events of a subscribed workflow', async () => {
    const id = await t.createWorkflow('Streamed', {
      nodes: [testNode('t', 'core.manualTrigger'), testNode('set', 'core.set')],
      connections: [link('t', 'set')],
    });
    const other = await t.createWorkflow('Not subscribed', {
      nodes: [testNode('t', 'core.manualTrigger')],
      connections: [],
    });

    const events: ExecutionEvent[] = [];
    socket.on('execution-event', (e: ExecutionEvent) => events.push(e));
    const ack = await socket.emitWithAck('subscribe', { workflowId: id });
    expect(ack).toEqual({ ok: true });

    await t.api().post(`/api/workflows/${other}/run?wait=true`).expect(200);
    const run = await t
      .api()
      .post(`/api/workflows/${id}/run?wait=true`)
      .send({ input: [{ a: 1 }, { a: 2 }] })
      .expect(200);

    await eventually(async () =>
      events.some((e) => e.type === 'execution.finished') ? true : undefined,
    );
    expect(events.every((e) => e.workflowId === id)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      'execution.queued',
      'execution.started',
      'node.started',
      'node.finished',
      'node.started',
      'node.finished',
      'execution.finished',
    ]);
    expect(events[3]).toMatchObject({
      nodeId: 't',
      status: 'success',
      itemCounts: [2],
    });
    expect(events.at(-1)).toMatchObject({
      executionId: run.body.id,
      status: 'success',
    });
  });

  it('rejects invalid subscriptions', async () => {
    const ack = await socket.emitWithAck('subscribe', { workflowId: 'nope' });
    expect(ack.ok).toBe(false);
  });
});
