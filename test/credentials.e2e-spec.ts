import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { Credential } from '../src/modules/credentials/credential.entity.js';
import { createTestApp, link, testNode, type TestApp } from './test-app.js';

describe('Credentials (e2e)', () => {
  let t: TestApp;
  let echo: Server;
  let echoUrl: string;
  const created: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    echo = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ authorization: req.headers.authorization ?? null }),
      );
    });
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const id of created) await t.api().delete(`/api/credentials/${id}`);
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    await t.close();
  });

  const createCredential = async (body: object) => {
    const res = await t.api().post('/api/credentials').send(body).expect(201);
    created.push(res.body.id);
    return res.body as { id: string; data: Record<string, unknown> };
  };

  it('lists credential types', async () => {
    const res = await t.api().get('/api/credential-types').expect(200);
    expect(res.body.map((c: { type: string }) => c.type)).toEqual([
      'httpHeaderAuth',
      'httpBasicAuth',
      'httpBearerAuth',
    ]);
  });

  it('encrypts data and never returns secrets', async () => {
    const credential = await createCredential({
      name: 'Basic',
      type: 'httpBasicAuth',
      data: { user: 'ann', password: 'super-secret' },
    });
    expect(credential.data).toEqual({ user: 'ann' });

    const stored = await t.app
      .get(DataSource)
      .getRepository(Credential)
      .findOneByOrFail({ id: credential.id });
    expect(stored.data).toMatch(/^v1:/);
    expect(stored.data).not.toContain('super-secret');

    const fetched = await t
      .api()
      .get(`/api/credentials/${credential.id}`)
      .expect(200);
    expect(fetched.body.data).toEqual({ user: 'ann' });
  });

  it('validates data against the credential type', async () => {
    await t
      .api()
      .post('/api/credentials')
      .send({ name: 'x', type: 'nope', data: {} })
      .expect(400);
    const res = await t
      .api()
      .post('/api/credentials')
      .send({ name: 'x', type: 'httpBasicAuth', data: { user: 'a', extra: 1 } })
      .expect(400);
    expect(res.body.issues).toEqual([
      'Unknown field "extra"',
      '"password" is required',
    ]);
  });

  it('is used by the HTTP Request node, and updates merge data', async () => {
    const credential = await createCredential({
      name: 'Token',
      type: 'httpBearerAuth',
      data: { token: 'first' },
    });
    const id = await t.createWorkflow('Authed request', {
      nodes: [
        testNode('t', 'core.manualTrigger'),
        testNode(
          'http',
          'core.httpRequest',
          { url: echoUrl, authentication: 'httpBearerAuth' },
          { credentials: { httpBearerAuth: credential.id } },
        ),
      ],
      connections: [link('t', 'http')],
    });

    const run = async () => {
      const res = await t
        .api()
        .post(`/api/workflows/${id}/run?wait=true`)
        .expect(200);
      expect(res.body.status).toBe('success');
      return res.body.steps[1].output[0][0].json.authorization as string;
    };

    expect(await run()).toBe('Bearer first');

    await t
      .api()
      .put(`/api/credentials/${credential.id}`)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(await run()).toBe('Bearer first');

    await t
      .api()
      .put(`/api/credentials/${credential.id}`)
      .send({ data: { token: 'second' } })
      .expect(200);
    expect(await run()).toBe('Bearer second');
  });

  it('fails the run when the credential type does not match', async () => {
    const credential = await createCredential({
      name: 'Header',
      type: 'httpHeaderAuth',
      data: { name: 'X-Key', value: 'v' },
    });
    const id = await t.createWorkflow('Wrong type', {
      nodes: [
        testNode('t', 'core.manualTrigger'),
        testNode(
          'http',
          'core.httpRequest',
          { url: echoUrl, authentication: 'httpBearerAuth' },
          { credentials: { httpBearerAuth: credential.id } },
        ),
      ],
      connections: [link('t', 'http')],
    });
    const res = await t
      .api()
      .post(`/api/workflows/${id}/run?wait=true`)
      .expect(200);
    expect(res.body.status).toBe('error');
    expect(res.body.error.message).toContain('expected httpBearerAuth');
  });
});
