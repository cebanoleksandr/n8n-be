import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local HTTP server for node tests:
 *   /slow?ms=5000     responds after a delay
 *   /flaky?key=k&n=2  fails the first n calls per key with 503
 *   /fail             always 500
 *   /file             a small PNG-typed file
 *   /echo-raw         echoes content-type, size and sha256 of the body
 *   /json             echoes method and parsed JSON body
 */
export async function startMockServer() {
  const calls = new Map<string, number>();
  const tokenRequests: Record<string, string>[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      switch (url.pathname) {
        case '/slow': {
          const timer = setTimeout(
            () => json(200, { slow: true }),
            Number(url.searchParams.get('ms') ?? 5000),
          );
          res.on('close', () => clearTimeout(timer));
          return;
        }
        case '/flaky': {
          const key = url.searchParams.get('key') ?? '';
          const n = (calls.get(key) ?? 0) + 1;
          calls.set(key, n);
          return n <= Number(url.searchParams.get('n') ?? 1)
            ? json(503, { attempt: n })
            : json(200, { attempt: n });
        }
        case '/headers':
          return json(200, {
            authorization: req.headers.authorization ?? null,
          });
        case '/oauth/token': {
          // Minimal OAuth2 token endpoint (form-encoded requests).
          const form = new URLSearchParams(body.toString());
          tokenRequests.push(Object.fromEntries(form));
          const grant = form.get('grant_type');
          if (grant === 'authorization_code') {
            if (
              form.get('code') !== 'good-code' ||
              !form.get('code_verifier')
            ) {
              return json(400, { error: 'invalid_grant' });
            }
            // Expires at once, so the next use must refresh.
            return json(200, {
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 1,
            });
          }
          if (
            grant === 'refresh_token' &&
            form.get('refresh_token') === 'refresh-1'
          ) {
            return json(200, { access_token: 'access-2', expires_in: 3600 });
          }
          if (grant === 'client_credentials') {
            return json(200, { access_token: 'cc-token', expires_in: 3600 });
          }
          return json(400, { error: 'unsupported_grant_type' });
        }
        case '/fail':
          return json(500, { error: 'boom' });
        case '/file':
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-disposition': 'attachment; filename="pixel.png"',
          });
          return res.end(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
        case '/echo-raw':
          return json(200, {
            type: req.headers['content-type'] ?? null,
            size: body.length,
            sha256: createHash('sha256').update(body).digest('hex'),
          });
        default:
          return json(200, {
            method: req.method,
            body: body.length ? JSON.parse(body.toString()) : null,
          });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    /** Bodies received by /oauth/token. */
    tokenRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const sha256 = (data: Buffer) =>
  createHash('sha256').update(data).digest('hex');
