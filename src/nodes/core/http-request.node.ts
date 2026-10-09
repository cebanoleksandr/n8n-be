import { NodeOperationError } from '../../engine/errors.js';
import { toText } from '../../engine/expression.js';
import type {
  JsonObject,
  JsonValue,
  NodeExecuteContext,
  NodeType,
} from '../../engine/types.js';
import type {
  HttpBasicAuth,
  HttpBearerAuth,
  HttpHeaderAuth,
} from '../credentials.js';

interface KeyValue {
  name: string;
  value: unknown;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const AUTH_TYPES = ['httpHeaderAuth', 'httpBasicAuth', 'httpBearerAuth'];

export const httpRequestNode: NodeType = {
  description: {
    type: 'core.httpRequest',
    version: 1,
    displayName: 'HTTP Request',
    description: 'Make an HTTP request for each input item',
    group: 'action',
    inputs: 1,
    outputs: ['main'],
    credentials: AUTH_TYPES.map((type) => ({
      type,
      required: true,
      displayOptions: { show: { authentication: [type] } },
    })),
    properties: [
      {
        name: 'authentication',
        displayName: 'Authentication',
        type: 'options',
        default: 'none',
        options: [
          { name: 'None', value: 'none' },
          { name: 'Header Auth', value: 'httpHeaderAuth' },
          { name: 'Basic Auth', value: 'httpBasicAuth' },
          { name: 'Bearer Token', value: 'httpBearerAuth' },
        ],
      },
      {
        name: 'method',
        displayName: 'Method',
        type: 'options',
        default: 'GET',
        options: METHODS.map((m) => ({ name: m, value: m })),
      },
      {
        name: 'url',
        displayName: 'URL',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'https://api.example.com/users',
      },
      {
        name: 'query',
        displayName: 'Query Parameters',
        type: 'list',
        default: [],
        itemProperties: [
          { name: 'name', displayName: 'Name', type: 'string', default: '' },
          { name: 'value', displayName: 'Value', type: 'string', default: '' },
        ],
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
      {
        name: 'body',
        displayName: 'JSON Body',
        type: 'json',
        default: '',
        displayOptions: { show: { method: BODY_METHODS } },
      },
      {
        name: 'responseFormat',
        displayName: 'Response Format',
        type: 'options',
        default: 'json',
        options: [
          { name: 'JSON', value: 'json' },
          { name: 'Text', value: 'text' },
        ],
      },
      {
        name: 'fullResponse',
        displayName: 'Include Status and Headers',
        type: 'boolean',
        default: false,
      },
      {
        name: 'timeoutMs',
        displayName: 'Timeout (ms)',
        type: 'number',
        default: 30000,
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputItems();
    const output = [];
    const authHeaders = await resolveAuthHeaders(ctx);

    for (let i = 0; i < items.length; i++) {
      const method = ctx.getParameter<string>('method', i);
      const rawUrl = ctx.getParameter<string>('url', i);
      if (!rawUrl) throw new NodeOperationError('URL is required', i);

      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw new NodeOperationError(`Invalid URL "${rawUrl}"`, i);
      }
      for (const q of ctx.getParameter<KeyValue[]>('query', i) ?? []) {
        if (q.name) url.searchParams.append(q.name, toText(q.value));
      }

      const headers: Record<string, string> = {};
      for (const h of ctx.getParameter<KeyValue[]>('headers', i) ?? []) {
        if (h.name) headers[h.name] = toText(h.value);
      }
      Object.assign(headers, authHeaders);

      let body: string | undefined;
      const rawBody = ctx.getParameter<unknown>('body', i);
      if (BODY_METHODS.includes(method) && rawBody !== '' && rawBody != null) {
        body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
        headers['content-type'] ??= 'application/json';
      }

      const response = await ctx.helpers.httpRequest({
        method,
        url: url.toString(),
        headers,
        body,
        timeoutMs: ctx.getParameter<number>('timeoutMs', i),
      });
      if (response.status >= 400) {
        throw new NodeOperationError(
          `Request failed with status ${response.status}: ${response.body.slice(0, 500)}`,
          i,
        );
      }

      const data = parseBody(
        response.body,
        ctx.getParameter<string>('responseFormat', i),
        i,
      );
      if (ctx.getParameter<boolean>('fullResponse', i)) {
        output.push({
          json: {
            statusCode: response.status,
            headers: response.headers,
            body: data,
          },
        });
      } else if (Array.isArray(data)) {
        // A JSON array response becomes one item per element, like in n8n.
        output.push(...data.map((d) => ({ json: toObject(d) })));
      } else {
        output.push({ json: toObject(data) });
      }
    }
    return [output];
  },
};

async function resolveAuthHeaders(
  ctx: NodeExecuteContext,
): Promise<Record<string, string>> {
  const auth = ctx.getParameter<string>('authentication', 0);
  switch (auth) {
    case 'httpHeaderAuth': {
      const c = await ctx.getCredentials<HttpHeaderAuth>(auth);
      return { [c.name]: c.value };
    }
    case 'httpBasicAuth': {
      const c = await ctx.getCredentials<HttpBasicAuth>(auth);
      const token = Buffer.from(`${c.user}:${c.password}`).toString('base64');
      return { authorization: `Basic ${token}` };
    }
    case 'httpBearerAuth': {
      const c = await ctx.getCredentials<HttpBearerAuth>(auth);
      return { authorization: `Bearer ${c.token}` };
    }
    case 'none':
    case undefined:
      return {};
    default:
      throw new NodeOperationError(`Unknown authentication "${auth}"`);
  }
}

function parseBody(body: string, format: string, itemIndex: number): JsonValue {
  if (format === 'text' || body === '') return body;
  try {
    return JSON.parse(body) as JsonValue;
  } catch {
    throw new NodeOperationError(
      'Response is not valid JSON; set Response Format to Text',
      itemIndex,
    );
  }
}

function toObject(value: JsonValue): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { data: value };
}
