import type { NodeType } from '../../engine/types.js';
import { CONDITION_PROPERTIES, itemMatches } from '../conditions.js';

export const filterNode: NodeType = {
  description: {
    type: 'core.filter',
    version: 1,
    displayName: 'Filter',
    description: 'Keep only items that match the conditions',
    group: 'transform',
    inputs: 1,
    outputs: ['kept'],
    properties: CONDITION_PROPERTIES,
  },
  async execute(ctx) {
    return [ctx.getInputItems().filter((_, i) => itemMatches(ctx, i))];
  },
};
