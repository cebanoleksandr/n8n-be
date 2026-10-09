import pg from 'pg';
import { NodeOperationError } from '../../engine/errors.js';
import { toText } from '../../engine/expression.js';
import type {
  Item,
  JsonObject,
  JsonValue,
  NodeType,
} from '../../engine/types.js';
import type { PostgresCredential } from '../credentials.js';
import { getPath, splitList } from '../utils.js';

const STATEMENT_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

export const postgresNode: NodeType = {
  description: {
    type: 'integrations.postgres',
    version: 1,
    displayName: 'Postgres',
    description: 'Run SQL queries or insert rows',
    group: 'action',
    inputs: 1,
    outputs: ['main'],
    credentials: [{ type: 'postgres', required: true }],
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'executeQuery',
        options: [
          { name: 'Execute query (once per item)', value: 'executeQuery' },
          { name: 'Insert rows (all items at once)', value: 'insert' },
        ],
      },
      {
        name: 'query',
        displayName: 'Query',
        type: 'code',
        default: 'SELECT now()',
        description:
          'Use $1, $2 ... placeholders with Query Parameters; never put item data in the SQL text',
        displayOptions: { show: { operation: ['executeQuery'] } },
      },
      {
        name: 'queryParameters',
        displayName: 'Query Parameters',
        type: 'list',
        default: [],
        itemProperties: [
          { name: 'value', displayName: 'Value', type: 'string', default: '' },
        ],
        displayOptions: { show: { operation: ['executeQuery'] } },
      },
      {
        name: 'table',
        displayName: 'Table',
        type: 'string',
        default: '',
        placeholder: 'public.users',
        displayOptions: { show: { operation: ['insert'] } },
      },
      {
        name: 'columns',
        displayName: 'Columns',
        type: 'string',
        default: '',
        placeholder: 'email, name',
        description:
          'Comma-separated; values are read from the item fields of the same name',
        displayOptions: { show: { operation: ['insert'] } },
      },
    ],
  },

  async execute(ctx) {
    const items = ctx.getInputItems();
    if (items.length === 0) return [[]];
    const credentials =
      await ctx.getCredentials<PostgresCredential>('postgres');
    const client = new pg.Client({
      host: credentials.host,
      port: Number(credentials.port) || 5432,
      database: credentials.database,
      user: credentials.user,
      password: credentials.password,
      ssl:
        credentials.ssl === 'verify'
          ? { rejectUnauthorized: true }
          : credentials.ssl === 'require'
            ? { rejectUnauthorized: false }
            : undefined,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      application_name: 'flow-platform',
    });
    const abort = () => void client.end();
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect();
      if (ctx.getParameter<string>('operation', 0) === 'insert') {
        return [await insert(ctx, client, items)];
      }
      const output: Item[] = [];
      for (let i = 0; i < items.length; i++) {
        const query = toText(ctx.node.parameters.query);
        if (!query.trim()) throw new NodeOperationError('Query is required', i);
        const params = (
          ctx.getParameter<{ value: unknown }[]>('queryParameters', i) ?? []
        ).map((p) => p.value);
        const result = await client.query(query, params);
        output.push(...result.rows.map((row) => ({ json: toJson(row) })));
      }
      return [output];
    } catch (err) {
      if (err instanceof NodeOperationError) throw err;
      throw new NodeOperationError(`Postgres: ${(err as Error).message}`);
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      await client.end().catch(() => undefined);
    }
  },
};

async function insert(
  ctx: Parameters<NodeType['execute']>[0],
  client: pg.Client,
  items: Item[],
): Promise<Item[]> {
  const table = ctx.getParameter<string>('table', 0);
  const columns = splitList(ctx.getParameter<string>('columns', 0));
  if (!table) throw new NodeOperationError('Table is required');
  if (columns.length === 0)
    throw new NodeOperationError('Name at least one column');

  const values: unknown[] = [];
  const rows = items.map((item) => {
    const placeholders = columns.map((column) => {
      const value = getPath(item.json, column);
      values.push(
        value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : (value ?? null),
      );
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  const sql = `INSERT INTO ${quoteName(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES ${rows.join(', ')} RETURNING *`;
  const result = await client.query(sql, values);
  return result.rows.map((row) => ({ json: toJson(row) }));
}

/** "schema.table" -> "schema"."table", with embedded quotes escaped. */
function quoteName(name: string): string {
  return name.split('.').map(quoteIdentifier).join('.');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.trim().replace(/"/g, '""')}"`;
}

/** Dates and big numbers become strings so rows are plain JSON. */
function toJson(row: Record<string, unknown>): JsonObject {
  return JSON.parse(
    JSON.stringify(row, (_, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  ) as Record<string, JsonValue>;
}
