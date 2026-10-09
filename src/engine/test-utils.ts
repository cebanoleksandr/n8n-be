import type { WorkflowConnection, WorkflowNode } from './types.js';

export function node(
  id: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    name: id,
    type,
    typeVersion: 1,
    position: [0, 0],
    parameters,
    ...extra,
  };
}

export function connect(
  from: string,
  to: string,
  fromIndex = 0,
  toIndex = 0,
): WorkflowConnection {
  return {
    from: { nodeId: from, index: fromIndex },
    to: { nodeId: to, index: toIndex },
  };
}
