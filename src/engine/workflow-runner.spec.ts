import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { builtinNodes } from '../nodes/index.js';
import { WorkflowValidationError } from './errors.js';
import { NodeRegistry } from './node-registry.js';
import { connect, node } from './test-utils.js';
import type { BinaryRef, BinaryStore, NodeType } from './types.js';
import { WorkflowRunner } from './workflow-runner.js';

const failingNode: NodeType = {
  description: {
    type: 'test.fail',
    version: 1,
    displayName: 'Fail',
    description: '',
    group: 'action',
    inputs: 1,
    outputs: ['main'],
    properties: [],
  },
  async execute() {
    throw new Error('boom');
  },
};

const mergeNode: NodeType = {
  description: {
    type: 'test.merge',
    version: 1,
    displayName: 'Merge',
    description: '',
    group: 'flow',
    inputs: 2,
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx) {
    return [[...ctx.getInputItems(0), ...ctx.getInputItems(1)]];
  },
};

/** Fails until it has been called `failTimes` times (per run, via the parameter). */
let flakyCalls = 0;
const flakyNode: NodeType = {
  description: { ...failingNode.description, type: 'test.flaky' },
  async execute(ctx) {
    flakyCalls++;
    if (flakyCalls <= ctx.getParameter<number>('failTimes', 0)) {
      throw new Error(`flaky failure ${flakyCalls}`);
    }
    return [ctx.getInputItems()];
  },
};

/** Never resolves and ignores the abort signal. */
const hangingNode: NodeType = {
  description: { ...failingNode.description, type: 'test.hang' },
  execute: () => new Promise(() => {}),
};

const runner = new WorkflowRunner(
  new NodeRegistry([
    ...builtinNodes,
    failingNode,
    mergeNode,
    flakyNode,
    hangingNode,
  ]),
);

class MemoryBinaryStore implements BinaryStore {
  readonly files = new Map<string, Buffer>();
  async put(data: Buffer, meta: { fileName?: string; mimeType: string }) {
    const ref: BinaryRef = {
      id: `bin-${this.files.size + 1}`,
      size: data.length,
      ...meta,
    };
    this.files.set(ref.id, data);
    return ref;
  }
  async get(ref: BinaryRef) {
    return this.files.get(ref.id)!;
  }
}

const ageCheck = node('if', 'core.if', {
  conditions: [
    { leftValue: '{{ $json.age }}', operator: 'gte', rightValue: '18' },
  ],
});

describe('WorkflowRunner', () => {
  it('runs a linear workflow and resolves expressions', async () => {
    const result = await runner.run({
      graph: {
        nodes: [
          node('trigger', 'core.manualTrigger'),
          node('set', 'core.set', {
            assignments: [
              {
                name: 'greeting',
                type: 'string',
                value: 'Hello {{ $json.name }}',
              },
              { name: 'meta.age', type: 'number', value: '{{ $json.age }}' },
            ],
          }),
        ],
        connections: [connect('trigger', 'set')],
      },
      triggerItems: [{ json: { name: 'Ann', age: '30' } }],
    });

    expect(result.status).toBe('success');
    expect(result.nodes.map((n) => n.nodeId)).toEqual(['trigger', 'set']);
    expect(result.nodes[1].output[0]).toEqual([
      {
        json: {
          name: 'Ann',
          age: '30',
          greeting: 'Hello Ann',
          meta: { age: 30 },
        },
      },
    ]);
  });

  it('routes items through IF and skips branches without data', async () => {
    const result = await runner.run({
      graph: {
        nodes: [
          node('trigger', 'core.manualTrigger'),
          ageCheck,
          node('adult', 'core.set', {
            assignments: [{ name: 'adult', type: 'boolean', value: 'true' }],
          }),
          node('minor', 'core.set', {
            assignments: [{ name: 'adult', type: 'boolean', value: 'false' }],
          }),
        ],
        connections: [
          connect('trigger', 'if'),
          connect('if', 'adult', 0),
          connect('if', 'minor', 1),
        ],
      },
      triggerItems: [{ json: { age: 30 } }, { json: { age: 40 } }],
    });

    expect(result.status).toBe('success');
    expect(result.nodes.map((n) => n.nodeId)).toEqual([
      'trigger',
      'if',
      'adult',
    ]);
    expect(result.nodes[2].output[0].map((i) => i.json.adult)).toEqual([
      true,
      true,
    ]);
  });

  it('feeds multiple inputs and does not leak mutations between branches', async () => {
    const result = await runner.run({
      graph: {
        nodes: [
          node('trigger', 'core.manualTrigger'),
          node('a', 'core.set', {
            assignments: [{ name: 'v', type: 'string', value: 'a' }],
          }),
          node('b', 'core.set', {
            assignments: [{ name: 'v', type: 'string', value: 'b' }],
          }),
          node('merge', 'test.merge'),
        ],
        connections: [
          connect('trigger', 'a'),
          connect('trigger', 'b'),
          connect('a', 'merge', 0, 0),
          connect('b', 'merge', 0, 1),
        ],
      },
    });

    expect(result.nodes.at(-1)!.output[0].map((i) => i.json.v)).toEqual([
      'a',
      'b',
    ]);
  });

  it('stops on error and reports the failing node', async () => {
    const finished: string[] = [];
    const result = await runner.run({
      graph: {
        nodes: [
          node('trigger', 'core.manualTrigger'),
          node('fail', 'test.fail'),
          node('after', 'core.set'),
        ],
        connections: [connect('trigger', 'fail'), connect('fail', 'after')],
      },
      hooks: {
        nodeFinished: (r) => void finished.push(`${r.nodeId}:${r.status}`),
      },
    });

    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ nodeId: 'fail', message: 'boom' });
    expect(finished).toEqual(['trigger:success', 'fail:error']);
  });

  it('continues with an error item when continueOnFail is set', async () => {
    const result = await runner.run({
      graph: {
        nodes: [
          node('trigger', 'core.manualTrigger'),
          node('fail', 'test.fail', {}, { continueOnFail: true }),
          node('after', 'core.set'),
        ],
        connections: [connect('trigger', 'fail'), connect('fail', 'after')],
      },
    });

    expect(result.status).toBe('success');
    expect(result.nodes.at(-1)!.output[0]).toEqual([
      { json: { error: 'boom' } },
    ]);
  });

  it('passes data through disabled nodes', async () => {
    const result = await runner.run({
      graph: {
        nodes: [
          node('trigger', 'core.manualTrigger'),
          node('off', 'test.fail', {}, { disabled: true }),
          node('after', 'core.set'),
        ],
        connections: [connect('trigger', 'off'), connect('off', 'after')],
      },
      triggerItems: [{ json: { x: 1 } }],
    });

    expect(result.status).toBe('success');
    expect(result.nodes.map((n) => n.nodeId)).toEqual(['trigger', 'after']);
  });

  it('ignores nodes not reachable from the trigger', async () => {
    const result = await runner.run({
      graph: {
        nodes: [
          node('trigger', 'core.manualTrigger'),
          node('orphan', 'test.fail'),
        ],
        connections: [],
      },
    });
    expect(result.status).toBe('success');
    expect(result.nodes).toHaveLength(1);
  });

  it('throws on an invalid graph or a missing trigger', async () => {
    await expect(
      runner.run({
        graph: { nodes: [node('s', 'core.set')], connections: [] },
      }),
    ).rejects.toThrow('Workflow has no trigger node');
    await expect(
      runner.run({ graph: { nodes: [node('x', 'unknown')], connections: [] } }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('returns canceled when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run({
      graph: {
        nodes: [node('trigger', 'core.manualTrigger')],
        connections: [],
      },
      signal: controller.signal,
    });
    expect(result.status).toBe('canceled');
  });

  describe('retries', () => {
    beforeEach(() => {
      flakyCalls = 0;
    });

    const flakyGraph = (failTimes: number, extra = {}) => ({
      nodes: [
        node('trigger', 'core.manualTrigger'),
        node(
          'flaky',
          'test.flaky',
          { failTimes },
          {
            retryOnFail: true,
            maxTries: 3,
            waitBetweenTriesMs: 1,
            ...extra,
          },
        ),
      ],
      connections: [connect('trigger', 'flaky')],
    });

    it('retries a failing node until it succeeds', async () => {
      const result = await runner.run({ graph: flakyGraph(2) });
      expect(result.status).toBe('success');
      expect(result.nodes[1]).toMatchObject({ status: 'success', tries: 3 });
    });

    it('fails with the last error once maxTries is reached', async () => {
      const result = await runner.run({ graph: flakyGraph(5) });
      expect(result.status).toBe('error');
      expect(result.nodes[1]).toMatchObject({ status: 'error', tries: 3 });
      expect(result.error?.message).toBe('flaky failure 3');
    });

    it('does not retry without retryOnFail', async () => {
      const result = await runner.run({
        graph: flakyGraph(1, { retryOnFail: false }),
      });
      expect(result.nodes[1].tries).toBe(1);
      expect(flakyCalls).toBe(1);
    });

    it('stops waiting between tries when aborted', async () => {
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(new Error('stop')), 20);
      const result = await runner.run({
        graph: flakyGraph(5, { waitBetweenTriesMs: 60_000 }),
        signal: controller.signal,
      });
      expect(result.status).toBe('canceled');
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  describe('abort', () => {
    it('interrupts a node that ignores the signal', async () => {
      const finished: string[] = [];
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node('hang', 'test.hang'),
            node('after', 'core.set'),
          ],
          connections: [connect('trigger', 'hang'), connect('hang', 'after')],
        },
        signal: AbortSignal.timeout(30),
        hooks: {
          nodeFinished: (r) => void finished.push(`${r.nodeId}:${r.status}`),
        },
      });
      expect(result.status).toBe('canceled');
      expect(finished).toEqual(['trigger:success', 'hang:error']);
      expect(result.nodes[1].error?.name).toBe('TimeoutError');
    });
  });

  describe('expression context', () => {
    it('exposes $workflow, $execution and earlier nodes', async () => {
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node('set', 'core.set', {
              assignments: [
                {
                  name: 'label',
                  type: 'string',
                  value:
                    '{{ $workflow.name }}/{{ $execution.mode }}/{{ $node["trigger"].json.n * 2 }}',
                },
              ],
            }),
          ],
          connections: [connect('trigger', 'set')],
        },
        triggerItems: [{ json: { n: 21 } }],
        workflow: { id: 'w', name: 'Orders' },
        execution: { id: 'e', mode: 'webhook' },
      });
      expect(result.nodes[1].output[0][0].json.label).toBe('Orders/webhook/42');
    });
  });

  describe('partial runs and pinned data', () => {
    // trigger -> a -> b -> c, and a -> side
    const chain = {
      nodes: [
        node('trigger', 'core.manualTrigger'),
        node('a', 'core.set', {
          assignments: [{ name: 'a', type: 'number', value: '1' }],
        }),
        node('b', 'core.set', {
          assignments: [
            {
              name: 'b',
              type: 'string',
              value: 'from {{ $node["a"].json.a }}',
            },
          ],
        }),
        node('c', 'core.set', {
          assignments: [{ name: 'c', type: 'boolean', value: 'true' }],
        }),
        node('side', 'core.set'),
      ],
      connections: [
        connect('trigger', 'a'),
        connect('a', 'b'),
        connect('b', 'c'),
        connect('a', 'side'),
      ],
    };
    const ids = (r: { nodes: { nodeId: string }[] }) =>
      r.nodes.map((n) => n.nodeId);

    it('runs only up to the destination node', async () => {
      const result = await runner.run({ graph: chain, destinationNodeId: 'b' });
      expect(result.status).toBe('success');
      expect(ids(result)).toEqual(['trigger', 'a', 'b']);
    });

    it('re-runs from a node using earlier outputs', async () => {
      const result = await runner.run({
        graph: chain,
        runFrom: {
          nodeId: 'b',
          previousOutputs: {
            trigger: [[{ json: {} }]],
            a: [[{ json: { a: 42 } }]],
            b: [[{ json: { stale: true } }]],
          },
        },
      });
      expect(ids(result)).toEqual(['b', 'c']);
      expect(result.nodes[0].output[0][0].json).toEqual({
        a: 42,
        b: 'from 42',
      });
    });

    it('requires data for the node a partial run starts from', async () => {
      await expect(
        runner.run({
          graph: chain,
          runFrom: { nodeId: 'c', previousOutputs: {} },
        }),
      ).rejects.toThrow('No input data for "c"');
    });

    it('uses pinned data instead of executing nodes', async () => {
      const result = await runner.run({
        graph: chain,
        pinData: {
          trigger: [{ json: { pinnedTrigger: true } }],
          a: [{ json: { a: 7 } }, { json: { a: 8 } }],
        },
        destinationNodeId: 'b',
      });
      expect(
        result.nodes.map((n) => [n.nodeId, n.pinned ?? false, n.tries]),
      ).toEqual([
        ['trigger', true, 0],
        ['a', true, 0],
        ['b', false, 1],
      ]);
      expect(result.nodes[2].output[0].map((i) => i.json.b)).toEqual([
        'from 7',
        'from 8',
      ]);
    });

    it('rejects unknown nodes', async () => {
      await expect(
        runner.run({ graph: chain, destinationNodeId: 'nope' }),
      ).rejects.toThrow('Node "nope" not found');
    });
  });

  describe('HTTP Request node', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          if (req.url?.startsWith('/fail')) {
            res.writeHead(500).end('nope');
            return;
          }
          if (req.url?.startsWith('/file')) {
            res.writeHead(200, {
              'content-type': 'image/png; charset=binary',
              'content-disposition': 'attachment; filename="logo.png"',
            });
            res.end(Buffer.from([1, 2, 3]));
            return;
          }
          if (req.url?.startsWith('/echo-raw')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ type: req.headers['content-type'], body }),
            );
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              auth: req.headers['x-token'],
              authorization: req.headers.authorization,
              body,
            }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );

    it('sends a request per item with query, headers and body', async () => {
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node('http', 'core.httpRequest', {
              method: 'POST',
              url: `${baseUrl}/users/{{ $json.id }}`,
              query: [{ name: 'q', value: '{{ $json.id }}' }],
              headers: [{ name: 'x-token', value: 'secret' }],
              body: '{"id": {{ $json.id }}}',
            }),
          ],
          connections: [connect('trigger', 'http')],
        },
        triggerItems: [{ json: { id: 1 } }, { json: { id: 2 } }],
      });

      expect(result.status).toBe('success');
      expect(result.nodes[1].output[0].map((i) => i.json)).toEqual([
        {
          method: 'POST',
          url: '/users/1?q=1',
          auth: 'secret',
          body: '{"id": 1}',
        },
        {
          method: 'POST',
          url: '/users/2?q=2',
          auth: 'secret',
          body: '{"id": 2}',
        },
      ]);
    });

    it('fails on HTTP error status', async () => {
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node('http', 'core.httpRequest', { url: `${baseUrl}/fail` }),
          ],
          connections: [connect('trigger', 'http')],
        },
      });
      expect(result.status).toBe('error');
      expect(result.error?.message).toContain('status 500');
    });

    it('adds auth headers from the selected credential', async () => {
      const requested: string[] = [];
      const credentials = {
        get: async (id: string, type: string) => {
          requested.push(`${id}:${type}`);
          return { user: 'ann', password: 'pw' };
        },
      };
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node(
              'http',
              'core.httpRequest',
              { url: baseUrl, authentication: 'httpBasicAuth' },
              { credentials: { httpBasicAuth: 'cred-1' } },
            ),
          ],
          connections: [connect('trigger', 'http')],
        },
        credentials,
      });

      expect(result.status).toBe('success');
      expect(requested).toEqual(['cred-1:httpBasicAuth']);
      expect(result.nodes[1].output[0][0].json.authorization).toBe(
        `Basic ${Buffer.from('ann:pw').toString('base64')}`,
      );
    });

    it('fails when the node has no credential selected', async () => {
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node('http', 'core.httpRequest', {
              url: baseUrl,
              authentication: 'httpBearerAuth',
            }),
          ],
          connections: [connect('trigger', 'http')],
        },
      });
      expect(result.error?.message).toBe(
        'No "httpBearerAuth" credential selected',
      );
    });

    it('downloads a response as a file and sends it back as a body', async () => {
      const store = new MemoryBinaryStore();
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node('download', 'core.httpRequest', {
              url: `${baseUrl}/file`,
              responseFormat: 'file',
            }),
            node('upload', 'core.httpRequest', {
              method: 'POST',
              url: `${baseUrl}/echo-raw`,
              sendBinary: true,
            }),
          ],
          connections: [
            connect('trigger', 'download'),
            connect('download', 'upload'),
          ],
        },
        binary: store,
      });

      expect(result.status).toBe('success');
      const downloaded = result.nodes[1].output[0][0];
      expect(downloaded.binary?.data).toEqual({
        id: 'bin-1',
        fileName: 'logo.png',
        mimeType: 'image/png',
        size: 3,
      });
      expect(store.files.get('bin-1')).toEqual(Buffer.from([1, 2, 3]));
      expect(result.nodes[2].output[0][0].json).toEqual({
        type: 'image/png',
        body: Buffer.from([1, 2, 3]).toString(),
      });
    });

    it('fails clearly without binary storage', async () => {
      const result = await runner.run({
        graph: {
          nodes: [
            node('trigger', 'core.manualTrigger'),
            node('download', 'core.httpRequest', {
              url: `${baseUrl}/file`,
              responseFormat: 'file',
            }),
          ],
          connections: [connect('trigger', 'download')],
        },
      });
      expect(result.error?.message).toBe(
        'Binary data storage is not configured',
      );
    });
  });
});
