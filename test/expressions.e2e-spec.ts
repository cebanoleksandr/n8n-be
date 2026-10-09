import { createTestApp, type TestApp } from './test-app.js';

describe('Expressions API (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(() => t.close());

  it('serves the autocomplete reference', async () => {
    const res = await t.api().get('/api/expressions/reference').expect(200);
    const names = (list: { name: string }[]) => list.map((e) => e.name);
    expect(names(res.body.variables)).toEqual(
      expect.arrayContaining(['$json', '$node', '$binary', '$now']),
    );
    expect(names(res.body.functions)).toEqual(
      expect.arrayContaining(['round', 'dateAdd', 'parseJson']),
    );
    expect(names(res.body.methods.array)).toEqual(
      expect.arrayContaining(['map', 'filter', 'join']),
    );
    expect(res.body.methods.string[0]).toEqual({
      name: 'toUpperCase',
      signature: 'toUpperCase()',
      description: expect.any(String),
    });
  });

  it('evaluates expressions on sample data', async () => {
    const res = await t
      .api()
      .post('/api/expressions/evaluate')
      .send({
        expression:
          '{{ $json.items.filter(i => i.qty > 0).length }} of {{ $node["Fetch"].json.total }}',
        json: { items: [{ qty: 1 }, { qty: 0 }, { qty: 2 }] },
        nodes: { Fetch: [{ total: 3 }] },
      })
      .expect(200);
    expect(res.body).toEqual({ value: '2 of 3' });

    const typed = await t
      .api()
      .post('/api/expressions/evaluate')
      .send({ expression: '{{ [1, 2].map(x => x * 2) }}' })
      .expect(200);
    expect(typed.body).toEqual({ value: [2, 4] });
  });

  it('reports expression errors as 400', async () => {
    const res = await t
      .api()
      .post('/api/expressions/evaluate')
      .send({ expression: '{{ process.env }}' })
      .expect(400);
    expect(res.body.message).toContain('Unknown variable "process"');
  });
});
