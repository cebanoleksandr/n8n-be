import type { NodeType } from '../../engine/types.js';

export const WEBHOOK_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];
export type WebhookResponseMode = 'onReceived' | 'lastNode' | 'responseNode';

const PATH_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/** Strips surrounding slashes; returns null when the path has invalid characters. */
export function normalizeWebhookPath(path: string): string | null {
  const normalized = path.trim().replace(/^\/+|\/+$/g, '');
  return PATH_PATTERN.test(normalized) ? normalized : null;
}

export const webhookNode: NodeType = {
  description: {
    type: 'core.webhook',
    version: 1,
    displayName: 'Webhook',
    description:
      'Starts the workflow when an HTTP request hits /webhook/<path>. Active workflows only',
    group: 'trigger',
    inputs: 0,
    outputs: ['main'],
    properties: [
      {
        name: 'path',
        displayName: 'Path',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'orders/created',
        description: 'Letters, digits, "-", "_" and "/"',
      },
      {
        name: 'method',
        displayName: 'HTTP Method',
        type: 'options',
        default: 'POST',
        options: WEBHOOK_METHODS.map((m) => ({ name: m, value: m })),
      },
      {
        name: 'responseMode',
        displayName: 'Respond',
        type: 'options',
        default: 'onReceived',
        options: [
          { name: 'Immediately (202 with execution id)', value: 'onReceived' },
          {
            name: 'When the workflow finishes (last node output)',
            value: 'lastNode',
          },
          { name: 'Using a Respond to Webhook node', value: 'responseNode' },
        ],
      },
    ],
  },
  // The request ({ body, query, headers, ... }) arrives as the trigger item.
  async execute(ctx) {
    return [ctx.getInputItems()];
  },
};
