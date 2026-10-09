import type { NodeType } from '../../engine/types.js';

export const errorTriggerNode: NodeType = {
  description: {
    type: 'core.errorTrigger',
    version: 1,
    displayName: 'Error Trigger',
    description:
      'Starts this workflow when another workflow that uses it as its error workflow fails',
    group: 'trigger',
    inputs: 0,
    outputs: ['main'],
    properties: [],
  },
  // Receives { execution: { id, mode, error, lastNodeExecuted, ... }, workflow: { id, name } }.
  async execute(ctx) {
    return [ctx.getInputItems()];
  },
};
