import type { HttpRequestOptions, HttpResponse } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export async function httpRequest(
  options: HttpRequestOptions,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const response = await fetch(options.url, {
    method: options.method,
    headers: options.headers,
    body: Buffer.isBuffer(options.body)
      ? new Uint8Array(options.body)
      : options.body,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ]),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  };
}
