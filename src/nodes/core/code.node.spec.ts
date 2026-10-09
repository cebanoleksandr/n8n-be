import { NodeRegistry } from '../../engine/node-registry.js';
import { connect, node } from '../../engine/test-utils.js';
import type { JsonObject } from '../../engine/types.js';
import { WorkflowRunner } from '../../engine/workflow-runner.js';
import { codeSandbox } from '../../sandbox/sandbox-client.js';
import { builtinNodes } from '../index.js';

const runner = new WorkflowRunner(new NodeRegistry(builtinNodes));

async function runCode(
  params: Record<string, unknown>,
  input: JsonObject[] = [{ n: 1 }, { n: 2 }],
) {
  return runner.run({
    graph: {
      nodes: [
        node('t', 'core.manualTrigger'),
        node('prev', 'core.set', {
          assignments: [{ name: 'from', type: 'string', value: 'prev' }],
        }),
        node('code', 'core.code', params),
      ],
      connections: [connect('t', 'prev'), connect('prev', 'code')],
    },
    triggerItems: input.map((json) => ({ json })),
    workflow: { id: 'w1', name: 'Demo' },
  });
}

const output = (r: Awaited<ReturnType<typeof runCode>>) =>
  r.nodes.at(-1)!.output[0].map((i) => i.json);

describe('Code node', () => {
  afterAll(() => codeSandbox.close());

  it('runs once for all items', async () => {
    const r = await runCode({
      code: `return items.map((i) => ({ double: i.json.n * 2, wf: $workflow.name }));`,
    });
    expect(r.status).toBe('success');
    expect(output(r)).toEqual([
      { double: 2, wf: 'Demo' },
      { double: 4, wf: 'Demo' },
    ]);
  });

  it('runs once per item and can drop items', async () => {
    const r = await runCode({
      mode: 'eachItem',
      code: `if ($json.n === 1) return null; return { n: $json.n, index: $itemIndex };`,
    });
    expect(output(r)).toEqual([{ n: 2, index: 1 }]);
  });

  it('supports async code, earlier nodes and { json } items', async () => {
    const r = await runCode({
      code: `
        await new Promise((resolve) => resolve());
        const first = $('prev').first();
        return [{ json: { from: first.json.from, count: $input.all().length } }];`,
    });
    expect(output(r)).toEqual([{ from: 'prev', count: 2 }]);
  });

  it('reports errors with console output', async () => {
    const r = await runCode({
      code: `console.log('checking', { a: 1 }); throw new Error('bad input');`,
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('bad input');
    expect(r.error?.message).toContain('checking {"a":1}');
  });

  it('rejects non-object results', async () => {
    const r = await runCode({ code: `return [1, 2];` });
    expect(r.error?.message).toContain(
      'Code must return objects; item 0 is number',
    );
  });

  it.each([
    ['process', `return [{ t: typeof process }]`, 'undefined'],
    ['require', `return [{ t: typeof require }]`, 'undefined'],
    ['fetch', `return [{ t: typeof fetch }]`, 'undefined'],
    ['setTimeout', `return [{ t: typeof setTimeout }]`, 'undefined'],
    [
      'constructor escape',
      `return [{ t: typeof (function(){}).constructor('return this')().process }]`,
      'undefined',
    ],
  ])('has no access to %s', async (_, code, expected) => {
    const r = await runCode({ code });
    expect(output(r)[0].t).toBe(expected);
  });

  it('stops infinite loops and never-settling promises', async () => {
    const loop = await runCode({ code: `while (true) {}`, timeoutMs: 300 });
    expect(loop.status).toBe('error');
    expect(loop.error?.message).toMatch(/timed out|did not finish/i);

    const hang = await runCode({
      code: `await new Promise(() => {}); return [];`,
      timeoutMs: 300,
    });
    expect(hang.status).toBe('error');
    expect(hang.error?.message).toMatch(/did not finish|timed out/i);
  });

  it('enforces the memory limit and keeps working afterwards', async () => {
    const r = await runCode({
      code: `const a = []; while (true) a.push(new Array(1e6).fill('x'));`,
      memoryMb: 16,
      timeoutMs: 10_000,
    });
    expect(r.status).toBe('error');
    const after = await runCode({ code: `return [{ ok: true }]` });
    expect(output(after)).toEqual([{ ok: true }]);
  });
});
