import { randomUUID } from 'node:crypto';
import { testEnv } from './test-env.js';
import { createTestApp, link, testNode, type TestApp } from './test-app.js';

describe('Postgres node (e2e)', () => {
  let t: TestApp;
  let credentialId: string;
  const table = `people_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    t = await createTestApp();
    const db = new URL(testEnv.DATABASE_URL);
    const res = await t
      .api()
      .post('/api/credentials')
      .send({
        name: 'Test DB',
        type: 'postgres',
        data: {
          host: db.hostname,
          port: Number(db.port),
          database: db.pathname.slice(1),
          user: db.username,
          password: db.password,
        },
      })
      .expect(201);
    credentialId = res.body.id;
    await query(
      `CREATE TABLE ${table} (id serial PRIMARY KEY, email text NOT NULL, tags jsonb)`,
    );
  });

  afterAll(async () => {
    await query(`DROP TABLE IF EXISTS ${table}`);
    await t.api().delete(`/api/credentials/${credentialId}`);
    await t.close();
  });

  /** Runs one Postgres node; returns its output JSON or throws its error. */
  async function runPostgres(
    parameters: Record<string, unknown>,
    input: object[] = [{}],
  ) {
    const id = await t.createWorkflow('Postgres', {
      nodes: [
        testNode('t', 'core.manualTrigger'),
        testNode('pg', 'integrations.postgres', parameters, {
          credentials: { postgres: credentialId },
        }),
      ],
      connections: [link('t', 'pg')],
    });
    const run = await t
      .api()
      .post(`/api/workflows/${id}/run?wait=true`)
      .send({ input })
      .expect(200);
    if (run.body.status !== 'success') throw new Error(run.body.error.message);
    return run.body.steps[1].output[0].map((i: { json: unknown }) => i.json);
  }

  const query = (sql: string) => runPostgres({ query: sql });

  it('inserts all items in one statement and returns the rows', async () => {
    const rows = await runPostgres(
      { operation: 'insert', table, columns: 'email, tags' },
      [
        { email: 'ann@example.com', tags: ['a'] },
        { email: 'bob@example.com', tags: [] },
      ],
    );
    expect(rows).toEqual([
      { id: 1, email: 'ann@example.com', tags: ['a'] },
      { id: 2, email: 'bob@example.com', tags: [] },
    ]);
  });

  it('runs parameterized queries per item; parameters stay data', async () => {
    const rows = await runPostgres(
      {
        query: `SELECT id, email FROM ${table} WHERE email = $1`,
        queryParameters: [{ value: '{{ $json.email }}' }],
      },
      [{ email: 'bob@example.com' }, { email: "x' OR '1'='1" }],
    );
    expect(rows).toEqual([{ id: 2, email: 'bob@example.com' }]);
  });

  it('quotes identifiers', async () => {
    await expect(
      runPostgres(
        {
          operation: 'insert',
          table: `${table}"; DROP TABLE x; --`,
          columns: 'email',
        },
        [{ email: 'z' }],
      ),
    ).rejects.toThrow(/Postgres: relation .* does not exist/);
  });

  it('reports SQL errors', async () => {
    await expect(query('SELEC 1')).rejects.toThrow(/Postgres: syntax error/);
  });
});
