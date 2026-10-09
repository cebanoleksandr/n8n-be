import type { NodeType } from '../engine/types.js';
import { postgresNode } from './integrations/postgres.node.js';
import { sendEmailNode } from './integrations/send-email.node.js';
import { slackNode } from './integrations/slack.node.js';
import { telegramNode } from './integrations/telegram.node.js';
import { codeNode } from './core/code.node.js';
import { aggregateNode } from './core/aggregate.node.js';
import {
  executeWorkflowNode,
  executeWorkflowTriggerNode,
} from './core/execute-workflow.node.js';
import { filterNode } from './core/filter.node.js';
import { limitNode } from './core/limit.node.js';
import { mergeNode } from './core/merge.node.js';
import { respondToWebhookNode } from './core/respond-to-webhook.node.js';
import { removeDuplicatesNode } from './core/remove-duplicates.node.js';
import { sortNode } from './core/sort.node.js';
import { splitOutNode } from './core/split-out.node.js';
import { switchNode } from './core/switch.node.js';
import { waitNode } from './core/wait.node.js';
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
  executeWorkflowTriggerNode,
  setNode,
  ifNode,
  httpRequestNode,
  switchNode,
  mergeNode,
  filterNode,
  splitOutNode,
  aggregateNode,
  sortNode,
  limitNode,
  removeDuplicatesNode,
  executeWorkflowNode,
  waitNode,
  respondToWebhookNode,
  codeNode,
  telegramNode,
  slackNode,
  postgresNode,
  sendEmailNode,
];

export { builtinCredentialTypes } from './credentials.js';
