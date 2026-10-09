import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BinaryData } from '../src/modules/binary-data/binary-data.entity.js';
import { BinaryDataService } from '../src/modules/binary-data/binary-data.service.js';
import { sha256, startMockServer } from './mock-server.js';
import { createTestApp, link, testNode, type TestApp } from './test-app.js';

describe('Binary data (e2e)', () => {
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

  const download = (id: string) =>
    t
      .api()
      .get(`/api/binary-data/${id}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  /** Webhook -> HTTP Request that posts the received file to /echo-raw. */
  const uploadWorkflow = async (field: string) => {
    const path = `upload-${randomUUID()}`;
    const id = await t.createWorkflow('Upload', {
      nodes: [
        testNode('hook', 'core.webhook', { path, responseMode: 'lastNode' }),
        testNode('echo', 'core.httpRequest', {
          method: 'POST',
          url: `${mock.url}/echo-raw`,
          sendBinary: true,
          inputBinaryField: field,
        }),
      ],
      connections: [link('hook', 'echo')],
    });
    await t
      .api()
      .put(`/api/workflows/${id}`)
      .send({ active: true })
      .expect(200);
    return { id, path };
  };

  it('accepts multipart uploads and passes files to nodes', async () => {
    const { path } = await uploadWorkflow('document');
    const file = Buffer.from('%PDF-1.7 fake pdf content');

    const res = await t
      .api()
      .post(`/webhook/${path}`)
      .field('title', 'Report')
      .attach('document', file, {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      })
      .expect(200);

    expect(res.body).toEqual({
      type: 'application/pdf',
      size: file.length,
      sha256: sha256(file),
    });
  });

  it('stores a raw request body as the "data" file', async () => {
    const { id, path } = await uploadWorkflow('data');
    const file = Buffer.from([0, 1, 2, 3, 255]);

    const res = await t
      .api()
      .post(`/webhook/${path}`)
      .set('content-type', 'application/octet-stream')
      .send(file)
      .expect(200);
    expect(res.body.sha256).toBe(sha256(file));

    const list = await t.api().get(`/api/executions?workflowId=${id}`);
    const execution = (
      await t.api().get(`/api/executions/${list.body.items[0].id}`)
    ).body;
    const ref = execution.steps[0].output[0][0].binary.data;
    expect(ref).toMatchObject({
      mimeType: 'application/octet-stream',
      size: 5,
    });

    const stored = await download(ref.id).expect(200);
    expect(stored.headers['content-type']).toBe('application/octet-stream');
    expect(stored.headers['x-content-type-options']).toBe('nosniff');
    expect(stored.body).toEqual(file);
  });

  it('downloads files with HTTP Request and serves them back', async () => {
    const id = await t.createWorkflow('Download', {
      nodes: [
        testNode('t', 'core.manualTrigger'),
        testNode('get', 'core.httpRequest', {
          url: `${mock.url}/file`,
          responseFormat: 'file',
          outputBinaryField: 'image',
        }),
        testNode('set', 'core.set', {
          assignments: [
            {
              name: 'name',
              type: 'string',
              value: '{{ $binary.image.fileName }}',
            },
          ],
        }),
      ],
      connections: [link('t', 'get'), link('get', 'set')],
    });
    const run = await t
      .api()
      .post(`/api/workflows/${id}/run?wait=true`)
      .expect(200);
    expect(run.body.status).toBe('success');
    const item = run.body.steps[2].output[0][0];
    expect(item.json.name).toBe('pixel.png');
    expect(item.binary.image).toMatchObject({ mimeType: 'image/png', size: 7 });

    const res = await download(item.binary.image.id).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''pixel.png",
    );
    expect(res.body).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  });

  it('cleans up files of deleted workflows', async () => {
    const res = await t
      .api()
      .post('/api/workflows')
      .send({
        name: 'Temporary',
        graph: {
          nodes: [
            testNode('t', 'core.manualTrigger'),
            testNode('get', 'core.httpRequest', {
              url: `${mock.url}/file`,
              responseFormat: 'file',
            }),
          ],
          connections: [link('t', 'get')],
        },
      })
      .expect(201);
    const run = await t
      .api()
      .post(`/api/workflows/${res.body.id}/run?wait=true`)
      .expect(200);
    const fileId = run.body.steps[1].output[0][0].binary.data.id as string;

    await t.api().delete(`/api/workflows/${res.body.id}`).expect(204);
    const row = await t.app
      .get(DataSource)
      .getRepository(BinaryData)
      .findOneByOrFail({ id: fileId });
    expect(row.workflowId).toBeNull();

    await t.app.get(BinaryDataService).deleteOrphans(0);
    await download(fileId).expect(404);
  });

  it('rejects uploads over the size limit', async () => {
    const { path } = await uploadWorkflow('data');
    const service = t.app.get(BinaryDataService);
    const big = Buffer.alloc(service.maxBytes + 1);
    await t
      .api()
      .post(`/webhook/${path}`)
      .set('content-type', 'application/octet-stream')
      .send(big)
      .expect(413);
  });

  it('returns 404 for unknown files', async () => {
    await download(randomUUID()).expect(404);
  });
});
