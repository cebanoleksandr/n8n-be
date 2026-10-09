import { NodeOperationError } from '../../engine/errors.js';
import { toText } from '../../engine/expression.js';
import type {
  BinaryRef,
  Item,
  JsonObject,
  NodeType,
} from '../../engine/types.js';
import { CodeError, codeSandbox } from '../../sandbox/sandbox-client.js';

const DEFAULT_CODE = `// All input items: items (also $input.all()). Earlier nodes: $('Node name').all().
// Return an array of objects (or of { json, binary } items).
return items.map((item) => ({ ...item.json, processed: true }));`;

const MAX_TIMEOUT_MS = 60_000;

export const codeNode: NodeType = {
  description: {
    type: 'core.code',
    version: 1,
    displayName: 'Code',
    description:
      'Run JavaScript in an isolated sandbox (no network, files or Node APIs)',
    group: 'transform',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'allItems',
        options: [
          { name: 'Run once for all items', value: 'allItems' },
          { name: 'Run once for each item', value: 'eachItem' },
        ],
      },
      {
        name: 'code',
        displayName: 'JavaScript',
        type: 'code',
        default: DEFAULT_CODE,
        description:
          'Each item mode: item, $json, $itemIndex; return one object (or null to drop it). Async/await works; console.log is captured.',
      },
      {
        name: 'timeoutMs',
        displayName: 'Timeout (ms)',
        type: 'number',
        default: 10_000,
      },
      {
        name: 'memoryMb',
        displayName: 'Memory Limit (MB)',
        type: 'number',
        default: 128,
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputItems();
    // Read raw: the code itself is not an expression template.
    const code = toText(ctx.node.parameters.code ?? DEFAULT_CODE);
    const mode = ctx.getParameter<'allItems' | 'eachItem'>('mode', 0);
    const timeoutMs = clamp(
      ctx.getParameter('timeoutMs', 0),
      100,
      MAX_TIMEOUT_MS,
      10_000,
    );
    const memoryMb = clamp(ctx.getParameter('memoryMb', 0), 16, 512, 128);

    let result: unknown;
    try {
      ({ result } = await codeSandbox.run({
        code,
        mode,
        input: { items, nodes: ctx.getNodeOutputs(), ...ctx.getRunInfo() },
        timeoutMs,
        memoryMb,
      }));
    } catch (err) {
      if (err instanceof CodeError) {
        const logs = err.logs.length
          ? `\nconsole output:\n${err.logs.join('\n')}`
          : '';
        throw new NodeOperationError(`${err.message}${logs}`);
      }
      throw err;
    }

    if (mode === 'eachItem') {
      const results = result as unknown[];
      return [results.flatMap((r, i) => (r === null ? [] : [toItem(r, i)]))];
    }
    const list = Array.isArray(result)
      ? result
      : result === null
        ? []
        : [result];
    return [list.map((r, i) => toItem(r, i))];
  },
};

function clamp(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.min(Math.max(Math.floor(n), min), max)
    : fallback;
}

/** Accepts { json, binary? } items or plain objects (wrapped as json). */
function toItem(value: unknown, index: number): Item {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeOperationError(
      `Code must return objects; item ${index} is ${Array.isArray(value) ? 'an array' : typeof value}`,
      index,
    );
  }
  const record = value as Record<string, unknown>;
  const isItem =
    record.json !== null &&
    typeof record.json === 'object' &&
    !Array.isArray(record.json) &&
    Object.keys(record).every((k) => k === 'json' || k === 'binary');
  if (!isItem) return { json: record as JsonObject };
  return {
    json: record.json as JsonObject,
    ...(record.binary
      ? { binary: record.binary as Record<string, BinaryRef> }
      : {}),
  };
}
