import nodemailer from 'nodemailer';
import { NodeOperationError } from '../../engine/errors.js';
import type { Item, NodeType } from '../../engine/types.js';
import type { SmtpCredential } from '../credentials.js';
import { splitList } from '../utils.js';

export const sendEmailNode: NodeType = {
  description: {
    type: 'integrations.sendEmail',
    version: 1,
    displayName: 'Send Email',
    description: 'Send an email per item over SMTP, with optional attachments',
    group: 'action',
    inputs: 1,
    outputs: ['main'],
    credentials: [{ type: 'smtp', required: true }],
    properties: [
      {
        name: 'from',
        displayName: 'From',
        type: 'string',
        default: '',
        required: true,
      },
      {
        name: 'to',
        displayName: 'To',
        type: 'string',
        default: '',
        required: true,
      },
      { name: 'cc', displayName: 'CC', type: 'string', default: '' },
      { name: 'subject', displayName: 'Subject', type: 'string', default: '' },
      { name: 'text', displayName: 'Text', type: 'string', default: '' },
      { name: 'html', displayName: 'HTML', type: 'string', default: '' },
      {
        name: 'attachments',
        displayName: 'Attachments (binary fields)',
        type: 'string',
        default: '',
        placeholder: 'data, invoice',
      },
    ],
  },

  async execute(ctx) {
    const credentials = await ctx.getCredentials<SmtpCredential>('smtp');
    const transport = nodemailer.createTransport({
      host: credentials.host,
      port: Number(credentials.port) || 587,
      secure: credentials.secure === true,
      auth: credentials.user
        ? { user: credentials.user, pass: credentials.password ?? '' }
        : undefined,
      connectionTimeout: 15_000,
      socketTimeout: 60_000,
    });
    const items = ctx.getInputItems();
    const output: Item[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        const to = ctx.getParameter<string>('to', i);
        const from = ctx.getParameter<string>('from', i);
        if (!to || !from)
          throw new NodeOperationError('From and To are required', i);

        const attachments = [];
        for (const field of splitList(
          ctx.getParameter<string>('attachments', i),
        )) {
          const ref = items[i].binary?.[field];
          if (!ref)
            throw new NodeOperationError(
              `Item has no binary field "${field}"`,
              i,
            );
          attachments.push({
            filename: ref.fileName ?? field,
            contentType: ref.mimeType,
            content: await ctx.helpers.readBinary(ref),
          });
        }

        const info = await transport.sendMail({
          from,
          to,
          cc: ctx.getParameter<string>('cc', i) || undefined,
          subject: ctx.getParameter<string>('subject', i),
          text: ctx.getParameter<string>('text', i) || undefined,
          html: ctx.getParameter<string>('html', i) || undefined,
          attachments,
        });
        output.push({
          json: {
            messageId: info.messageId,
            accepted: info.accepted.map(String),
            rejected: info.rejected.map(String),
          },
        });
      }
    } catch (err) {
      if (err instanceof NodeOperationError) throw err;
      throw new NodeOperationError(`SMTP: ${(err as Error).message}`);
    } finally {
      transport.close();
    }
    return [output];
  },
};
