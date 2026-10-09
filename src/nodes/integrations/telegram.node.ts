import { NodeOperationError } from '../../engine/errors.js';
import { toText } from '../../engine/expression.js';
import type { Item, JsonObject, NodeType } from '../../engine/types.js';
import type { TelegramApi } from '../credentials.js';
import { jsonRequest, trimSlash } from './api-request.js';

export const telegramNode: NodeType = {
  description: {
    type: 'integrations.telegram',
    version: 1,
    displayName: 'Telegram',
    description: 'Send messages and files with a Telegram bot',
    group: 'action',
    inputs: 1,
    outputs: ['main'],
    credentials: [{ type: 'telegramApi', required: true }],
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'sendMessage',
        options: [
          { name: 'Send message', value: 'sendMessage' },
          { name: 'Send document (file)', value: 'sendDocument' },
        ],
      },
      {
        name: 'chatId',
        displayName: 'Chat ID',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'text',
        displayName: 'Text',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['sendMessage'] } },
      },
      {
        name: 'parseMode',
        displayName: 'Parse Mode',
        type: 'options',
        default: 'none',
        options: [
          { name: 'Plain text', value: 'none' },
          { name: 'Markdown V2', value: 'MarkdownV2' },
          { name: 'HTML', value: 'HTML' },
        ],
        displayOptions: { show: { operation: ['sendMessage'] } },
      },
      {
        name: 'binaryField',
        displayName: 'Binary Field',
        type: 'string',
        default: 'data',
        displayOptions: { show: { operation: ['sendDocument'] } },
      },
      {
        name: 'caption',
        displayName: 'Caption',
        type: 'string',
        default: '',
        displayOptions: { show: { operation: ['sendDocument'] } },
      },
      {
        name: 'disableNotification',
        displayName: 'Send Silently',
        type: 'boolean',
        default: false,
      },
    ],
  },

  async execute(ctx) {
    const credentials = await ctx.getCredentials<TelegramApi>('telegramApi');
    const base = `${trimSlash(credentials.baseUrl, 'https://api.telegram.org')}/bot${credentials.accessToken}`;
    const items = ctx.getInputItems();
    const output: Item[] = [];

    for (let i = 0; i < items.length; i++) {
      const operation = ctx.getParameter<string>('operation', i);
      const chatId = ctx.getParameter<string>('chatId', i);
      if (!chatId) throw new NodeOperationError('Chat ID is required', i);
      const silent = ctx.getParameter<boolean>('disableNotification', i);

      let data: Record<string, unknown>;
      if (operation === 'sendDocument') {
        const field = ctx.getParameter<string>('binaryField', i);
        const ref = items[i].binary?.[field];
        if (!ref)
          throw new NodeOperationError(
            `Item has no binary field "${field}"`,
            i,
          );
        const form = new FormData();
        form.set('chat_id', String(chatId));
        form.set(
          'document',
          new Blob([new Uint8Array(await ctx.helpers.readBinary(ref))], {
            type: ref.mimeType,
          }),
          ref.fileName ?? 'file',
        );
        const caption = ctx.getParameter<string>('caption', i);
        if (caption) form.set('caption', caption);
        if (silent) form.set('disable_notification', 'true');
        // multipart: the engine helper sends raw bodies, so build it with Request.
        const request = new Request(`${base}/sendDocument`, {
          method: 'POST',
          body: form,
        });
        const response = await ctx.helpers.httpRequest({
          method: 'POST',
          url: request.url,
          headers: { 'content-type': request.headers.get('content-type')! },
          body: Buffer.from(await request.arrayBuffer()),
        });
        data = JSON.parse(response.body.toString('utf8')) as Record<
          string,
          unknown
        >;
      } else {
        const text = ctx.getParameter<string>('text', i);
        if (!text) throw new NodeOperationError('Text is required', i);
        const parseMode = ctx.getParameter<string>('parseMode', i);
        data = await jsonRequest(
          ctx,
          'Telegram',
          {
            method: 'POST',
            url: `${base}/sendMessage`,
            body: {
              chat_id: chatId,
              text,
              ...(parseMode !== 'none' && { parse_mode: parseMode }),
              ...(silent && { disable_notification: true }),
            },
          },
          i,
        );
      }
      if (data.ok !== true) {
        throw new NodeOperationError(
          `Telegram error: ${toText(data.description) || 'unknown error'}`,
          i,
        );
      }
      output.push({ json: data.result as JsonObject });
    }
    return [output];
  },
};
