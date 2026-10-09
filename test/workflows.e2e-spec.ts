import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import type { WorkflowGraph } from '../src/engine/types.js';

// Requires Postgres from docker-compose and DATABASE_URL in .env.
describe('Workflows & executions (e2e)', () => {
  let app: NestExpressApplication;
  const created: string[] = [];

  const graph: WorkflowGraph = {
    nodes: [
      {
        id: 't',
        name: 'Start',
        type: 'core.manualTrigger',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        id: 'if',
        name: 'Is adult',
        type: 'core.if',
        typeVersion: 1,
        position: [200, 0],
        parameters: {
          conditions: [
            { leftValue: '{{ $json.age }}', operator: 'gte', rightValue: '18' },
          ],
        },
      },
      {
        id: 'set',
        name: 'Mark',
        type: 'core.set',
        typeVersion: 1,
        position: [400, 0],
        parameters: {
          assignments: [
            { name: 'greeting', type: 'string', value: 'Hi {{ $json.name }}' },
          ],
        },
      },
    ],
    connections: [
      { from: { nodeId: 't', index: 0 }, to: { nodeId: 'if', index: 0 } },
      { from: { nodeId: 'if', index: 0 }, to: { nodeId: 'set', index: 0 } },
    ],
  };

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    for (const id of created) await api().delete(`/api/workflows/${id}`);
    await app.close();
  });

  it('reports health and lists node types', async () => {
    await api().get('/api/health').expect(200, { status: 'ok' });
    const res = await api().get('/api/node-types').expect(200);
    expect(res.body.map((n: { type: string }) => n.type)).toEqual(
      expect.arrayContaining([
        'core.manualTrigger',
        'core.set',
        'core.if',
        'core.httpRequest',
      ]),
    );
  });

  it('rejects invalid graphs', async () => {
    await api().post('/api/workflows').send({ name: '' }).expect(400);
    const res = await api()
      .post('/api/workflows')
      .send({
        name: 'Bad',
        graph: {
          ...graph,
          connections: [
            {
              from: { nodeId: 'set', index: 0 },
              to: { nodeId: 't', index: 0 },
            },
          ],
        },
      })
      .expect(400);
    expect(res.body.issues).toEqual([
      { nodeId: 't', message: 'Node "Start" has no input 0' },
    ]);
  });

  it('creates, versions, runs and records a workflow', async () => {
    const createRes = await api()
      .post('/api/workflows')
      .send({ name: 'Greeter' })
      .expect(201);
    const id: string = createRes.body.id;
    created.push(id);
    expect(createRes.body).toMatchObject({
      name: 'Greeter',
      version: 1,
      graph: { nodes: [], connections: [] },
    });

    const updated = await api()
      .put(`/api/workflows/${id}`)
      .send({ graph })
      .expect(200);
    expect(updated.body.version).toBe(2);

    // Saving the same graph again does not create a new version.
    const same = await api()
      .put(`/api/workflows/${id}`)
      .send({ graph, name: 'Greeter v2' })
      .expect(200);
    expect(same.body).toMatchObject({ version: 2, name: 'Greeter v2' });

    const versions = await api()
      .get(`/api/workflows/${id}/versions`)
      .expect(200);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([
      2, 1,
    ]);

    const run = await api()
      .post(`/api/workflows/${id}/run`)
      .send({
        input: [
          { name: 'Ann', age: 30 },
          { name: 'Bob', age: 12 },
        ],
      })
      .expect(201);
    expect(run.body).toMatchObject({
      status: 'success',
      workflowVersionId: updated.body.versionId,
      error: null,
    });
    expect(run.body.steps.map((s: { nodeId: string }) => s.nodeId)).toEqual([
      't',
      'if',
      'set',
    ]);
    expect(run.body.steps[2].output[0]).toEqual([
      { json: { name: 'Ann', age: 30, greeting: 'Hi Ann' } },
    ]);

    const fetched = await api()
      .get(`/api/executions/${run.body.id}`)
      .expect(200);
    expect(fetched.body).toEqual(run.body);

    const list = await api()
      .get(`/api/executions?workflowId=${id}`)
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).not.toHaveProperty('steps');
  });

  it('records a failed run when the workflow has no trigger', async () => {
    const res = await api()
      .post('/api/workflows')
      .send({ name: 'Empty' })
      .expect(201);
    created.push(res.body.id);
    const run = await api()
      .post(`/api/workflows/${res.body.id}/run`)
      .expect(201);
    expect(run.body).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('no trigger') },
    });
  });

  it('returns 404 for unknown ids and 400 for malformed ones', async () => {
    await api()
      .get('/api/workflows/00000000-0000-4000-8000-00000000ffff')
      .expect(404);
    await api().get('/api/workflows/not-a-uuid').expect(400);
  });
});
