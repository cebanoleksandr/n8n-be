import type { NodeType } from '../engine/types.js';
import { errorTriggerNode } from './core/error-trigger.node.js';
import { httpRequestNode } from './core/http-request.node.js';
import { ifNode } from './core/if.node.js';
import { manualTriggerNode } from './core/manual-trigger.node.js';
import { scheduleNode } from './core/schedule.node.js';
import { setNode } from './core/set.node.js';
import { webhookNode } from './core/webhook.node.js';

export const builtinNodes: NodeType[] = [
  manualTriggerNode,
  webhookNode,
  scheduleNode,
  errorTriggerNode,
  setNode,
  ifNode,
  httpRequestNode,
];

export { builtinCredentialTypes } from './credentials.js';
