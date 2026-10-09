import { NodeOperationError } from '../../engine/errors.js';
import { toText } from '../../engine/expression.js';
import type { NodeType } from '../../engine/types.js';

interface Header {
  name: string;
  value: unknown;
}

export const respondToWebhookNode: NodeType = {
  description: {
    type: 'core.respondToWebhook',
    version: 1,
    displayName: 'Respond to Webhook',
    description:
      'Send the HTTP response of a Webhook trigger set to "Using a Respond to Webhook node"',
    group: 'action',
    inputs: 1,
    outputs: ['main'],
    properties: [
      {
        name: 'respondWith',
        displayName: 'Respond With',
        type: 'options',
        default: 'firstItem',
        options: [
          { name: 'First incoming item', value: 'firstItem' },
          { name: 'All incoming items', value: 'allItems' },
          { name: 'JSON', value: 'json' },
          { name: 'Text', value: 'text' },
          { name: 'File (binary)', value: 'binary' },
          { name: 'No data', value: 'noData' },
        ],
      },
      {
        name: 'responseBody',
        displayName: 'Response Body',
        type: 'json',
        default: '',
        displayOptions: { show: { respondWith: ['json', 'text'] } },
      },
      {
        name: 'binaryField',
        displayName: 'Binary Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { respondWith: ['binary'] } },
      },
      {
        name: 'statusCode',
        displayName: 'Status Code',
        type: 'number',
        default: 200,
      },
      {
        name: 'headers',
        displayName: 'Headers',
        type: 'list',
        default: [],
        itemProperties: [
          { name: 'name', displayName: 'Name', type: 'string', default: '' },
          { name: 'value', displayName: 'Value', type: 'string', default: '' },
        ],
      },
    ],
  },

  // Responds once, based on the first item; items pass through unchanged.
  async execute(ctx) {
    const items = ctx.getInputItems();
    const statusCode = Number(ctx.getParameter('statusCode', 0)) || 200;
    if (statusCode < 100 || statusCode > 599) {
      throw new NodeOperationError(`Invalid status code ${statusCode}`);
    }
    const headers: Record<string, string> = {};
    for (const h of ctx.getParameter<Header[]>('headers', 0) ?? []) {
      if (h.name) headers[h.name.toLowerCase()] = toText(h.value);
    }

    const mode = ctx.getParameter<string>('respondWith', 0);
    switch (mode) {
      case 'allItems':
        await ctx.helpers.respondToWebhook({
          statusCode,
          headers,
          body: items.map((i) => i.json),
        });
        break;
      case 'json': {
        const raw = ctx.getParameter<unknown>('responseBody', 0);
        let body = raw;
        if (typeof raw === 'string') {
          try {
            body = raw === '' ? null : (JSON.parse(raw) as unknown);
          } catch {
            throw new NodeOperationError('Response Body is not valid JSON');
          }
        }
        await ctx.helpers.respondToWebhook({ statusCode, headers, body });
        break;
      }
      case 'text':
        headers['content-type'] ??= 'text/plain; charset=utf-8';
        await ctx.helpers.respondToWebhook({
          statusCode,
          headers,
          body: toText(ctx.getParameter('responseBody', 0)),
        });
        break;
      case 'binary': {
        const field = ctx.getParameter<string>('binaryField', 0);
        const ref = items[0]?.binary?.[field];
        if (!ref)
          throw new NodeOperationError(`Item has no binary field "${field}"`);
        await ctx.helpers.respondToWebhook({
          statusCode,
          headers,
          binary: ref,
        });
        break;
      }
      case 'noData':
        await ctx.helpers.respondToWebhook({ statusCode, headers });
        break;
      default:
        await ctx.helpers.respondToWebhook({
          statusCode,
          headers,
          body: items[0]?.json ?? {},
        });
    }
    return [items];
  },
};
