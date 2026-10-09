import { NodeOperationError } from '../../engine/errors.js';
import type { NodeType } from '../../engine/types.js';
import { compareValues, getPath } from '../utils.js';

interface SortField {
  field: string;
  order: 'asc' | 'desc';
}

export const sortNode: NodeType = {
  description: {
    type: 'core.sort',
    version: 1,
    displayName: 'Sort',
    description: 'Sort items by one or more fields',
    group: 'transform',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'fields',
        displayName: 'Sort By',
        type: 'list',
        default: [],
        itemProperties: [
          { name: 'field', displayName: 'Field', type: 'string', default: '' },
          {
            name: 'order',
            displayName: 'Order',
            type: 'options',
            default: 'asc',
            options: [
              { name: 'Ascending', value: 'asc' },
              { name: 'Descending', value: 'desc' },
            ],
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const fields = ctx.getParameter<SortField[]>('fields', 0) ?? [];
    if (fields.length === 0)
      throw new NodeOperationError('Add at least one field to sort by');
    const items = [...ctx.getInputItems()];
    items.sort((a, b) => {
      for (const { field, order } of fields) {
        const result = compareValues(
          getPath(a.json, field),
          getPath(b.json, field),
        );
        if (result !== 0) return order === 'desc' ? -result : result;
      }
      return 0;
    });
    return [items];
  },
};
