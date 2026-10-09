import { NodeOperationError } from '../../engine/errors.js';
import { toText } from '../../engine/expression.js';
import type { Item, JsonObject, NodeType } from '../../engine/types.js';
import type { SlackApi } from '../credentials.js';
import { jsonRequest, trimSlash } from './api-request.js';

export const slackNode: NodeType = {
  description: {
    type: 'integrations.slack',
    version: 1,
    displayName: 'Slack',
    description: 'Post messages to Slack channels',
    group: 'action',
    inputs: 1,
    outputs: ['main'],
    credentials: [{ type: 'slackApi', required: true }],
    properties: [
      {
        name: 'channel',
        displayName: 'Channel',
        type: 'string',
        default: '',
        required: true,
        placeholder: '#general or C0123456',
      },
      { name: 'text', displayName: 'Text', type: 'string', default: '' },
      {
        name: 'blocks',
        displayName: 'Blocks (JSON)',
        type: 'json',
        default: '',
        description:
          'Block Kit layout; the text is then used for notifications',
      },
      {
        name: 'threadTs',
        displayName: 'Reply in Thread (ts)',
        type: 'string',
        default: '',
      },
    ],
  },

  async execute(ctx) {
    const credentials = await ctx.getCredentials<SlackApi>('slackApi');
    const url = `${trimSlash(credentials.baseUrl, 'https://slack.com/api')}/chat.postMessage`;
    const items = ctx.getInputItems();
    const output: Item[] = [];

    for (let i = 0; i < items.length; i++) {
      const channel = ctx.getParameter<string>('channel', i);
      const text = ctx.getParameter<string>('text', i);
      const rawBlocks = ctx.getParameter<unknown>('blocks', i);
      if (!channel) throw new NodeOperationError('Channel is required', i);
      if (!text && !rawBlocks)
        throw new NodeOperationError('Text or blocks are required', i);

      let blocks: unknown;
      if (typeof rawBlocks === 'string' && rawBlocks.trim()) {
        try {
          blocks = JSON.parse(rawBlocks);
        } catch {
          throw new NodeOperationError('Blocks must be valid JSON', i);
        }
      } else if (rawBlocks && typeof rawBlocks === 'object') {
        blocks = rawBlocks;
      }
      const threadTs = ctx.getParameter<string>('threadTs', i);

      const data = await jsonRequest(
        ctx,
        'Slack',
        {
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${credentials.accessToken}` },
          body: {
            channel,
            ...(text && { text }),
            ...(blocks !== undefined && { blocks }),
            ...(threadTs && { thread_ts: threadTs }),
          },
        },
        i,
      );
      if (data.ok !== true) {
        throw new NodeOperationError(
          `Slack error: ${toText(data.error) || 'unknown error'}`,
          i,
        );
      }
      output.push({ json: data as JsonObject });
    }
    return [output];
  },
};
