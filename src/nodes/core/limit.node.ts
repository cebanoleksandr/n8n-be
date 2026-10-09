import type { NodeType } from '../../engine/types.js';

export const limitNode: NodeType = {
  description: {
    type: 'core.limit',
    version: 1,
    displayName: 'Limit',
    description: 'Keep only the first or last N items',
    group: 'transform',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'maxItems',
        displayName: 'Max Items',
        type: 'number',
        default: 1,
      },
      {
        name: 'keep',
        displayName: 'Keep',
        type: 'options',
        default: 'first',
        options: [
          { name: 'First items', value: 'first' },
          { name: 'Last items', value: 'last' },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputItems();
    const max = Math.max(
      0,
      Math.floor(Number(ctx.getParameter('maxItems', 0)) || 0),
    );
    if (max === 0) return [[]];
    return [
      ctx.getParameter<string>('keep', 0) === 'last'
        ? items.slice(-max)
        : items.slice(0, max),
    ];
  },
};
