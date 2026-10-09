import type { NodeType } from '../../engine/types.js';

export const manualTriggerNode: NodeType = {
  description: {
    type: 'core.manualTrigger',
    version: 1,
    displayName: 'Manual Trigger',
    description: 'Starts the workflow when you click "Run" in the editor',
    group: 'trigger',
    inputs: 0,
    outputs: ['main'],
    properties: [],
  },
  // The runner hands the trigger payload to the start node as its input.
  async execute(ctx) {
    return [ctx.getInputItems()];
  },
};
