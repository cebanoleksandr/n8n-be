import { NodeOperationError } from '../../engine/errors.js';
import type { NodeType } from '../../engine/types.js';
import { getPath, splitList } from '../utils.js';

export const removeDuplicatesNode: NodeType = {
  description: {
    type: 'core.removeDuplicates',
    version: 1,
    displayName: 'Remove Duplicates',
    description: 'Drop items that repeat earlier ones (first occurrence wins)',
    group: 'transform',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'compare',
        displayName: 'Compare',
        type: 'options',
        default: 'allFields',
        options: [
          { name: 'All fields', value: 'allFields' },
          { name: 'Selected fields', value: 'selectedFields' },
        ],
      },
      {
        name: 'fields',
        displayName: 'Fields',
        type: 'string',
        default: '',
        placeholder: 'email',
        displayOptions: { show: { compare: ['selectedFields'] } },
      },
    ],
  },
  async execute(ctx) {
    const selected =
      ctx.getParameter<string>('compare', 0) === 'selectedFields';
    const fields = splitList(ctx.getParameter<string>('fields', 0));
    if (selected && fields.length === 0)
      throw new NodeOperationError('Name at least one field');
    const seen = new Set<string>();
    return [
      ctx.getInputItems().filter((item) => {
        const key = selected
          ? JSON.stringify(fields.map((f) => getPath(item.json, f) ?? null))
          : stableStringify(item.json);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    ];
  },
};

/** JSON with sorted keys, so {a,b} and {b,a} are duplicates. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
