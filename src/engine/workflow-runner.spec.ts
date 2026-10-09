import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { builtinNodes } from '../nodes/index.js';
import { WorkflowValidationError } from './errors.js';
import { NodeRegistry } from './node-registry.js';
import { connect, node } from './test-utils.js';
import type { NodeType } from './types.js';
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

const runner = new WorkflowRunner(
  new NodeRegistry([...builtinNodes, failingNode, mergeNode]),
);

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
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              method: req.method,
              url: req.url,
              auth: req.headers['x-token'],
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
  });
});
