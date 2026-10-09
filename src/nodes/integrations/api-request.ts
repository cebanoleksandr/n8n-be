import { NodeOperationError } from '../../engine/errors.js';
import type { NodeExecuteContext } from '../../engine/types.js';

/** JSON request through the engine's HTTP helper (abortable, timed out). */
export async function jsonRequest(
  ctx: NodeExecuteContext,
  service: string,
  options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
  itemIndex: number,
): Promise<Record<string, unknown>> {
  const response = await ctx.helpers.httpRequest({
    method: options.method,
    url: options.url,
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined && {
        'content-type': 'application/json; charset=utf-8',
      }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(response.body.toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new NodeOperationError(
      `${service} returned a non-JSON response (status ${response.status})`,
      itemIndex,
    );
  }
  return data;
}

export function trimSlash(url: string | undefined, fallback: string): string {
  return (url || fallback).replace(/\/+$/, '');
}
