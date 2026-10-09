import type { NodeType } from '../engine/types.js';
import { httpRequestNode } from './core/http-request.node.js';
import { ifNode } from './core/if.node.js';
import { manualTriggerNode } from './core/manual-trigger.node.js';
import { setNode } from './core/set.node.js';

export const builtinNodes: NodeType[] = [
  manualTriggerNode,
  setNode,
  ifNode,
  httpRequestNode,
];
