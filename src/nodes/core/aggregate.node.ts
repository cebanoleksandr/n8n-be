import { NodeOperationError } from '../../engine/errors.js';
import type { JsonObject, JsonValue, NodeType } from '../../engine/types.js';
import { getPath, splitList } from '../utils.js';

export const aggregateNode: NodeType = {
  description: {
    type: 'core.aggregate',
    version: 1,
    displayName: 'Aggregate',
    description: 'Combine all items into a single item',
    group: 'transform',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'mode',
        displayName: 'Aggregate',
        type: 'options',
        default: 'allItems',
        options: [
          { name: 'All item data', value: 'allItems' },
          { name: 'Individual fields', value: 'fields' },
        ],
      },
      {
        name: 'destination',
        displayName: 'Put Items In Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { mode: ['allItems'] } },
      },
      {
        name: 'fields',
        displayName: 'Fields',
        type: 'string',
        default: '',
        placeholder: 'email, name',
        description:
          'Comma-separated dot paths; each becomes an array of values',
        displayOptions: { show: { mode: ['fields'] } },
      },
      {
        name: 'skipEmpty',
        displayName: 'Skip Missing Values',
        type: 'boolean',
        default: true,
        displayOptions: { show: { mode: ['fields'] } },
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputItems();
    if (items.length === 0) return [[]];
    if (ctx.getParameter<string>('mode', 0) === 'allItems') {
      const destination = ctx.getParameter<string>('destination', 0) || 'data';
      return [[{ json: { [destination]: items.map((i) => i.json) } }]];
    }
    const fields = splitList(ctx.getParameter<string>('fields', 0));
    if (fields.length === 0)
      throw new NodeOperationError('Name at least one field');
    const skipEmpty = ctx.getParameter<boolean>('skipEmpty', 0);
    const json: JsonObject = {};
    for (const field of fields) {
      const values = items.map(
        (i) => getPath(i.json, field) as JsonValue | undefined,
      );
      json[field.split('.').at(-1)!] = (
        skipEmpty
          ? values.filter((v) => v !== undefined && v !== null)
          : values.map((v) => v ?? null)
      ) as JsonValue[];
    }
    return [[{ json }]];
  },
};
