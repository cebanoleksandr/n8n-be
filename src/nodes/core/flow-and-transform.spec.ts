import { NodeRegistry } from '../../engine/node-registry.js';
import { connect, node } from '../../engine/test-utils.js';
import type { Item, JsonObject, WorkflowGraph } from '../../engine/types.js';
import { WorkflowRunner } from '../../engine/workflow-runner.js';
import { validateGraph } from '../../engine/graph.js';
import { builtinNodes } from '../index.js';

const registry = new NodeRegistry(builtinNodes);
const runner = new WorkflowRunner(registry);

/** Runs trigger -> node under test and returns that node's outputs as JSON. */
async function runNode(
  type: string,
  parameters: Record<string, unknown>,
  input: JsonObject[],
): Promise<JsonObject[][]> {
  const result = await runner.run({
    graph: {
      nodes: [node('t', 'core.manualTrigger'), node('n', type, parameters)],
      connections: [connect('t', 'n')],
    },
    triggerItems: input.map((json) => ({ json })),
  });
  if (result.status !== 'success') throw new Error(result.error?.message);
  return result.nodes[1].output.map((items) => items.map((i) => i.json));
}

const people = [
  { name: 'Ann', age: 30, city: 'Kyiv' },
  { name: 'Bob', age: 12, city: 'Lviv' },
  { name: 'Cid', age: 45, city: 'Kyiv' },
];

describe('Switch', () => {
  const rules = [
    {
      leftValue: '{{ $json.city }}',
      operator: 'equals',
      rightValue: 'Kyiv',
      outputKey: 'kyiv',
    },
    {
      leftValue: '{{ $json.age }}',
      operator: 'gte',
      rightValue: '18',
      outputKey: 'adult',
    },
  ];

  it('derives outputs from rules', () => {
    const type = registry.get('core.switch', 1)!;
    expect(type.outputsFor!({ rules })).toEqual(['kyiv', 'adult']);
    expect(type.outputsFor!({ rules, fallbackOutput: 'extra' })).toEqual([
      'kyiv',
      'adult',
      'fallback',
    ]);
  });

  it('sends each item to the first matching rule', async () => {
    const out = await runNode(
      'core.switch',
      { rules, fallbackOutput: 'extra' },
      people,
    );
    expect(out.map((o) => o.map((p) => p.name))).toEqual([
      ['Ann', 'Cid'],
      [],
      ['Bob'],
    ]);
  });

  it('can send items to all matching rules', async () => {
    const out = await runNode(
      'core.switch',
      { rules, mode: 'allMatches' },
      people,
    );
    expect(out.map((o) => o.map((p) => p.name))).toEqual([
      ['Ann', 'Cid'],
      ['Ann', 'Cid'],
    ]);
  });

  it('validates connections against dynamic outputs', () => {
    const graph: WorkflowGraph = {
      nodes: [node('s', 'core.switch', { rules }), node('x', 'core.set')],
      connections: [connect('s', 'x', 2)],
    };
    expect(validateGraph(graph, registry)).toEqual([
      { nodeId: 's', message: 'Node "s" has no output 2' },
    ]);
  });
});

describe('Merge', () => {
  async function merge(
    parameters: Record<string, unknown>,
    a: JsonObject[],
    b: JsonObject[],
  ) {
    const result = await runner.run({
      graph: {
        nodes: [
          node('t', 'core.manualTrigger'),
          node('a', 'core.set', {
            assignments: [
              { name: 'list', type: 'json', value: JSON.stringify(a) },
            ],
            keepOtherFields: false,
          }),
          node('b', 'core.set', {
            assignments: [
              { name: 'list', type: 'json', value: JSON.stringify(b) },
            ],
            keepOtherFields: false,
          }),
          node('splitA', 'core.splitOut', { field: 'list' }),
          node('splitB', 'core.splitOut', { field: 'list' }),
          node('m', 'core.merge', parameters),
        ],
        connections: [
          connect('t', 'a'),
          connect('t', 'b'),
          connect('a', 'splitA'),
          connect('b', 'splitB'),
          connect('splitA', 'm', 0, 0),
          connect('splitB', 'm', 0, 1),
        ],
      },
    });
    if (result.status !== 'success') throw new Error(result.error?.message);
    return result.nodes.at(-1)!.output[0].map((i: Item) => i.json);
  }

  const users = [
    { id: 1, name: 'Ann' },
    { id: 2, name: 'Bob' },
  ];
  const orders = [
    { userId: 1, total: 10 },
    { userId: 1, total: 20 },
    { userId: 3, total: 5 },
  ];

  it('appends', async () => {
    expect(await merge({ mode: 'append' }, [{ x: 1 }], [{ x: 2 }])).toEqual([
      { x: 1 },
      { x: 2 },
    ]);
  });

  it('combines by position', async () => {
    expect(await merge({ mode: 'combineByPosition' }, users, orders)).toEqual([
      { id: 1, name: 'Ann', userId: 1, total: 10 },
      { id: 2, name: 'Bob', userId: 1, total: 20 },
    ]);
  });

  it('joins by field (inner and left)', async () => {
    const params = { mode: 'combineByField', field1: 'id', field2: 'userId' };
    expect(await merge(params, users, orders)).toEqual([
      { id: 1, name: 'Ann', userId: 1, total: 10 },
      { id: 1, name: 'Ann', userId: 1, total: 20 },
    ]);
    expect(
      await merge({ ...params, join: 'left' }, users, orders),
    ).toHaveLength(3);
  });

  it('chooses a branch', async () => {
    expect(
      await merge(
        { mode: 'chooseBranch', output: 'input2' },
        [{ a: 1 }],
        [{ b: 2 }],
      ),
    ).toEqual([{ b: 2 }]);
  });
});

describe('transform nodes', () => {
  it('Filter keeps matching items', async () => {
    const out = await runNode(
      'core.filter',
      {
        conditions: [
          { leftValue: '{{ $json.age }}', operator: 'gte', rightValue: '18' },
        ],
      },
      people,
    );
    expect(out[0].map((p) => p.name)).toEqual(['Ann', 'Cid']);
  });

  it('Split Out turns arrays into items', async () => {
    const order = { id: 7, lines: [{ sku: 'a' }, { sku: 'b' }] };
    expect(await runNode('core.splitOut', { field: 'lines' }, [order])).toEqual(
      [[{ sku: 'a' }, { sku: 'b' }]],
    );
    expect(
      await runNode('core.splitOut', { field: 'lines', include: 'all' }, [
        order,
      ]),
    ).toEqual([
      [
        { id: 7, lines: { sku: 'a' } },
        { id: 7, lines: { sku: 'b' } },
      ],
    ]);
    expect(
      await runNode('core.splitOut', { field: 'tags' }, [{ tags: ['x', 'y'] }]),
    ).toEqual([[{ tags: 'x' }, { tags: 'y' }]]);
  });

  it('Aggregate collects items or fields', async () => {
    expect(await runNode('core.aggregate', {}, people.slice(0, 2))).toEqual([
      [{ data: people.slice(0, 2) }],
    ]);
    expect(
      await runNode(
        'core.aggregate',
        { mode: 'fields', fields: 'name, age' },
        people,
      ),
    ).toEqual([[{ name: ['Ann', 'Bob', 'Cid'], age: [30, 12, 45] }]]);
  });

  it('Sort orders by several fields', async () => {
    const out = await runNode(
      'core.sort',
      {
        fields: [
          { field: 'city', order: 'asc' },
          { field: 'age', order: 'desc' },
        ],
      },
      people,
    );
    expect(out[0].map((p) => p.name)).toEqual(['Cid', 'Ann', 'Bob']);
  });

  it('Limit keeps the first or last items', async () => {
    expect(
      (await runNode('core.limit', { maxItems: 2 }, people))[0],
    ).toHaveLength(2);
    const last = await runNode(
      'core.limit',
      { maxItems: 1, keep: 'last' },
      people,
    );
    expect(last[0][0].name).toBe('Cid');
  });

  it('Remove Duplicates compares all or selected fields', async () => {
    const items = [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      { a: 1, b: 3 },
    ];
    expect((await runNode('core.removeDuplicates', {}, items))[0]).toHaveLength(
      2,
    );
    expect(
      (
        await runNode(
          'core.removeDuplicates',
          { compare: 'selectedFields', fields: 'a' },
          items,
        )
      )[0],
    ).toEqual([{ a: 1, b: 2 }]);
  });
});
