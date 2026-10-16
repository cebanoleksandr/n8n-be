import type { WorkflowGraph } from '../src/engine/types.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('Workflows & executions (e2e)', () => {
  let t: TestApp;

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

  const api = () => t.api();

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

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

  it('searches and sorts the workflow list', async () => {
    // Other specs share the workspace: a unique prefix isolates these.
    const tag = `srch${Date.now()}`;
    await t.createWorkflow(`${tag} beta`);
    await t.createWorkflow(`${tag} Alpha`);
    await t.createWorkflow(`${tag} gamma_1`);
    await t.createWorkflow(`${tag} gamma%1`);

    const names = async (query: string) => {
      const res = await api().get(`/api/workflows?${query}`).expect(200);
      return {
        total: res.body.total as number,
        names: (res.body.items as { name: string }[]).map((w) => w.name),
      };
    };

    expect(await names(`search=${tag}&sort=name:asc`)).toEqual({
      total: 4,
      names: [
        `${tag} Alpha`,
        `${tag} beta`,
        `${tag} gamma%1`,
        `${tag} gamma_1`,
      ],
    });
    expect((await names(`search=${tag}&sort=name:desc`)).names[0]).toBe(
      `${tag} gamma_1`,
    );
    // Newest first, by creation.
    expect((await names(`search=${tag}&sort=createdAt:desc`)).names[0]).toBe(
      `${tag} gamma%1`,
    );
    // Case-insensitive; % and _ match only themselves.
    expect((await names(`search=${tag.toUpperCase()}%20ALPHA`)).names).toEqual([
      `${tag} Alpha`,
    ]);
    expect(
      (await names(`search=${encodeURIComponent(`${tag} gamma_`)}`)).names,
    ).toEqual([`${tag} gamma_1`]);
    expect(
      (await names(`search=${encodeURIComponent(`${tag} gamma%`)}`)).names,
    ).toEqual([`${tag} gamma%1`]);
    // Paging keeps the filter.
    expect(await names(`search=${tag}&sort=name:asc&limit=2&offset=2`)).toEqual(
      { total: 4, names: [`${tag} gamma%1`, `${tag} gamma_1`] },
    );

    await api().get('/api/workflows?sort=bogus').expect(400);
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
    const id = await t.createWorkflow('Greeter');
    const createRes = await api().get(`/api/workflows/${id}`).expect(200);
    expect(createRes.body).toMatchObject({
      name: 'Greeter',
      version: 1,
      active: false,
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
      .post(`/api/workflows/${id}/run?wait=true`)
      .send({
        input: [
          { name: 'Ann', age: 30 },
          { name: 'Bob', age: 12 },
        ],
      })
      .expect(200);
    expect(run.body).toMatchObject({
      status: 'success',
      mode: 'manual',
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
    expect(list.body.items[0].workflowName).toBe('Greeter v2');
    expect(fetched.body.workflowName).toBe('Greeter v2');
  });

  it('versions logic changes, not node moves, and restores old versions', async () => {
    const id = await t.createWorkflow('Versioned', graph);
    const save = (g: WorkflowGraph) =>
      api().put(`/api/workflows/${id}`).send({ graph: g }).expect(200);
    const versionsOf = async () =>
      (await api().get(`/api/workflows/${id}/versions`).expect(200)).body as {
        id: string;
        version: number;
      }[];

    // Moving nodes keeps version 1, and the new layout is saved.
    const moved = {
      ...graph,
      nodes: graph.nodes.map((n) => ({
        ...n,
        position: [n.position[0] + 50, n.position[1] + 10] as [number, number],
      })),
    };
    expect((await save(moved)).body.version).toBe(1);
    expect((await versionsOf()).map((v) => v.version)).toEqual([1]);
    const fetched = await api().get(`/api/workflows/${id}`).expect(200);
    expect(fetched.body.graph.nodes[0].position).toEqual([50, 10]);

    // A parameter change is a new version.
    const changed = {
      ...moved,
      nodes: moved.nodes.map((n) =>
        n.id === 'set'
          ? {
              ...n,
              parameters: {
                assignments: [
                  { name: 'greeting', type: 'string', value: 'Bye' },
                ],
              },
            }
          : n,
      ),
    };
    expect((await save(changed)).body.version).toBe(2);

    // Restoring version 1 brings its logic back as version 3.
    const v1 = (await versionsOf()).find((v) => v.version === 1)!;
    const restored = await api()
      .post(`/api/workflows/${id}/versions/${v1.id}/restore`)
      .expect(200);
    expect(restored.body.version).toBe(3);
    expect(restored.body.graph.nodes[2].parameters).toEqual(
      graph.nodes[2].parameters,
    );
    expect((await versionsOf()).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('records a failed run when the workflow has no trigger', async () => {
    const id = await t.createWorkflow('Empty');
    const run = await api()
      .post(`/api/workflows/${id}/run?wait=true`)
      .expect(200);
    expect(run.body).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('no trigger') },
    });
  });

  it('queues a run and returns 202 without wait', async () => {
    const id = await t.createWorkflow('Queued', graph);
    const res = await api().post(`/api/workflows/${id}/run`).expect(202);
    expect(res.body).toMatchObject({
      status: 'queued',
      startedAt: null,
      workflowName: 'Queued',
    });
    expect(res.body).not.toHaveProperty('steps');
  });

  it('returns 404 for unknown ids and 400 for malformed ones', async () => {
    await api()
      .get('/api/workflows/00000000-0000-4000-8000-00000000ffff')
      .expect(404);
    await api().get('/api/workflows/not-a-uuid').expect(400);
  });
});
