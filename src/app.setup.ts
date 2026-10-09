import { type INestApplicationContext, RequestMethod } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';

/** Settings shared by main.ts and e2e tests. */
export function configureApp(
  app: NestExpressApplication,
  corsOrigins: string[] = [],
  trustProxy: boolean | number | string = false,
): void {
  app.set('trust proxy', trustProxy);
  // Webhooks are public URLs: /webhook/<path> and /webhook-test/<path>, outside /api.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'webhook/*path', method: RequestMethod.ALL },
      { path: 'webhook-test/*path', method: RequestMethod.ALL },
    ],
  });
  // Workflow graphs and run inputs can exceed the 100kb default.
  app.useBodyParser('json', { limit: '5mb' });
  // credentials: the refresh token is an httpOnly cookie.
  app.enableCors({ origin: corsOrigins, credentials: true });
  app.useWebSocketAdapter(new CorsIoAdapter(app, corsOrigins));
  app.enableShutdownHooks();
}

class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins },
    } as ServerOptions) as Server;
  }
}
