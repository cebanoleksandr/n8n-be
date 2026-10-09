import type { Item, NodeType } from '../../engine/types.js';
import { CONDITION_PROPERTIES, itemMatches } from '../conditions.js';

export const ifNode: NodeType = {
  description: {
    type: 'core.if',
    version: 1,
    displayName: 'If',
    description: 'Route items to "true" or "false" depending on conditions',
    group: 'flow',
    inputs: 1,
    outputs: ['true', 'false'],
    properties: CONDITION_PROPERTIES,
  },

  async execute(ctx) {
    const trueItems: Item[] = [];
    const falseItems: Item[] = [];
    ctx.getInputItems().forEach((item, i) => {
      (itemMatches(ctx, i) ? trueItems : falseItems).push(item);
    });
    return [trueItems, falseItems];
  },
};
