import { builtinNodes } from '../nodes/index.js';
import {
  topologicalOrder,
  validateGraph,
  workflowGraphSchema,
} from './graph.js';
import { NodeRegistry } from './node-registry.js';
import { connect, node } from './test-utils.js';

const registry = new NodeRegistry(builtinNodes);

describe('validateGraph', () => {
  it('accepts a valid graph', () => {
    const graph = {
      nodes: [
        node('t', 'core.manualTrigger'),
        node('if', 'core.if'),
        node('s', 'core.set'),
      ],
      connections: [connect('t', 'if'), connect('if', 's', 1)],
    };
    expect(validateGraph(graph, registry)).toEqual([]);
  });

  it('reports duplicates, unknown types and bad endpoints', () => {
    const graph = {
      nodes: [node('a', 'core.set'), node('a', 'core.set'), node('x', 'nope')],
      connections: [connect('a', 'missing'), connect('a', 'a', 5)],
    };
    const messages = validateGraph(graph, registry).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Duplicate node id "a"',
        'Duplicate node name "a"',
        'Unknown node type nope@1',
        'Connection a -> missing references a missing node',
        'Node "a" has no output 5',
      ]),
    );
  });

  it('rejects connections into a trigger', () => {
    const graph = {
      nodes: [node('s', 'core.set'), node('t', 'core.manualTrigger')],
      connections: [connect('s', 't')],
    };
    expect(validateGraph(graph, registry)).toEqual([
      { nodeId: 't', message: 'Node "t" has no input 0' },
    ]);
  });

  it('detects cycles', () => {
    const graph = {
      nodes: [node('a', 'core.set'), node('b', 'core.set')],
      connections: [connect('a', 'b'), connect('b', 'a')],
    };
    expect(topologicalOrder(graph)).toBeNull();
    expect(validateGraph(graph, registry)).toEqual([
      { message: 'Workflow contains a cycle' },
    ]);
  });
});

describe('workflowGraphSchema', () => {
  it('rejects malformed input', () => {
    expect(
      workflowGraphSchema.safeParse({ nodes: [{ id: 'a' }], connections: [] })
        .success,
    ).toBe(false);
  });
});
