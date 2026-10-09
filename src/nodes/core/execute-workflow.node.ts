import { NodeOperationError } from '../../engine/errors.js';
import type { Item, NodeType } from '../../engine/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const executeWorkflowTriggerNode: NodeType = {
  description: {
    type: 'core.executeWorkflowTrigger',
    version: 1,
    displayName: 'Execute Workflow Trigger',
    description:
      'Starts this workflow when another workflow calls it with Execute Workflow',
    group: 'trigger',
    inputs: 0,
    outputs: ['main'],
    properties: [],
  },
  // Receives the caller's items unchanged.
  async execute(ctx) {
    return [ctx.getInputItems()];
  },
};

export const executeWorkflowNode: NodeType = {
  description: {
    type: 'core.executeWorkflow',
    version: 1,
    displayName: 'Execute Workflow',
    description:
      'Run another workflow (it needs an Execute Workflow Trigger). Batches turn it into a loop',
    group: 'flow',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'workflowId',
        displayName: 'Workflow ID',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'mode',
        displayName: 'Run',
        type: 'options',
        default: 'once',
        options: [
          { name: 'Once with all items', value: 'once' },
          { name: 'Once per item', value: 'eachItem' },
          { name: 'Once per batch', value: 'batches' },
        ],
      },
      {
        name: 'batchSize',
        displayName: 'Batch Size',
        type: 'number',
        default: 10,
        displayOptions: { show: { mode: ['batches'] } },
      },
      {
        name: 'waitForCompletion',
        displayName: 'Wait for Completion',
        type: 'boolean',
        default: true,
        description:
          "On: output the sub-workflow's last node output. Off: start it and pass items through",
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputItems();
    if (items.length === 0) return [[]];
    const workflowId = ctx.getParameter<string>('workflowId', 0);
    if (!UUID.test(workflowId ?? '')) {
      throw new NodeOperationError(`"${workflowId}" is not a workflow ID`);
    }
    const wait = ctx.getParameter<boolean>('waitForCompletion', 0);
    const mode = ctx.getParameter<string>('mode', 0);
    const size =
      mode === 'eachItem'
        ? 1
        : mode === 'batches'
          ? Math.max(
              1,
              Math.floor(Number(ctx.getParameter('batchSize', 0)) || 1),
            )
          : items.length;

    const output: Item[] = [];
    for (let start = 0; start < items.length; start += size) {
      if (ctx.signal.aborted) break;
      const batch = items.slice(start, start + size);
      const result = await ctx.helpers.executeWorkflow(workflowId, batch, wait);
      output.push(...(wait ? result : batch));
    }
    return [output];
  },
};
