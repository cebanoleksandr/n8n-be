import { NodeOperationError } from '../../engine/errors.js';
import type { Item, NodeType } from '../../engine/types.js';
import { getPath } from '../utils.js';

type Mode = 'append' | 'combineByPosition' | 'combineByField' | 'chooseBranch';

export const mergeNode: NodeType = {
  description: {
    type: 'core.merge',
    version: 1,
    displayName: 'Merge',
    description: 'Combine the items of two inputs',
    group: 'flow',
    inputs: 2,
    outputs: ['main'],
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'append',
        options: [
          { name: 'Append (input 1, then input 2)', value: 'append' },
          { name: 'Combine by position', value: 'combineByPosition' },
          { name: 'Combine by matching field', value: 'combineByField' },
          { name: 'Choose one input', value: 'chooseBranch' },
        ],
      },
      {
        name: 'field1',
        displayName: 'Input 1 Field',
        type: 'string',
        default: '',
        placeholder: 'id',
        displayOptions: { show: { mode: ['combineByField'] } },
      },
      {
        name: 'field2',
        displayName: 'Input 2 Field',
        type: 'string',
        default: '',
        placeholder: 'userId',
        displayOptions: { show: { mode: ['combineByField'] } },
      },
      {
        name: 'join',
        displayName: 'Keep',
        type: 'options',
        default: 'inner',
        options: [
          { name: 'Only matches', value: 'inner' },
          { name: 'All of input 1 (left join)', value: 'left' },
        ],
        displayOptions: { show: { mode: ['combineByField'] } },
      },
      {
        name: 'includeUnpaired',
        displayName: 'Include Unpaired Items',
        type: 'boolean',
        default: false,
        displayOptions: { show: { mode: ['combineByPosition'] } },
      },
      {
        name: 'output',
        displayName: 'Output',
        type: 'options',
        default: 'input1',
        options: [
          { name: 'Input 1', value: 'input1' },
          { name: 'Input 2', value: 'input2' },
        ],
        displayOptions: { show: { mode: ['chooseBranch'] } },
      },
    ],
  },

  async execute(ctx) {
    const a = ctx.getInputItems(0);
    const b = ctx.getInputItems(1);
    const mode = ctx.getParameter<Mode>('mode', 0);
    switch (mode) {
      case 'append':
        return [[...a, ...b]];
      case 'chooseBranch':
        return [ctx.getParameter<string>('output', 0) === 'input2' ? b : a];
      case 'combineByPosition': {
        const length = ctx.getParameter<boolean>('includeUnpaired', 0)
          ? Math.max(a.length, b.length)
          : Math.min(a.length, b.length);
        return [Array.from({ length }, (_, i) => combine(a[i], b[i]))];
      }
      case 'combineByField': {
        const field1 = ctx.getParameter<string>('field1', 0);
        const field2 = ctx.getParameter<string>('field2', 0);
        if (!field1 || !field2)
          throw new NodeOperationError('Both fields are required');
        const byKey = new Map<string, Item[]>();
        for (const item of b) {
          const key = JSON.stringify(getPath(item.json, field2) ?? null);
          byKey.set(key, [...(byKey.get(key) ?? []), item]);
        }
        const left = ctx.getParameter<string>('join', 0) === 'left';
        const output: Item[] = [];
        for (const item of a) {
          const matches = byKey.get(
            JSON.stringify(getPath(item.json, field1) ?? null),
          );
          if (matches) output.push(...matches.map((m) => combine(item, m)));
          else if (left) output.push(item);
        }
        return [output];
      }
      default:
        throw new NodeOperationError(`Unknown mode "${String(mode)}"`);
    }
  },
};

/** Input 2 fields win on conflicts; files from both are kept. */
function combine(a: Item | undefined, b: Item | undefined): Item {
  const binary = { ...a?.binary, ...b?.binary };
  return {
    json: { ...a?.json, ...b?.json },
    ...(Object.keys(binary).length > 0 && { binary }),
  };
}
