import type { NestExpressApplication } from '@nestjs/platform-express';

/** Settings shared by main.ts and e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  app.setGlobalPrefix('api');
  // Workflow graphs and run inputs can exceed the 100kb default.
  app.useBodyParser('json', { limit: '5mb' });
  app.enableShutdownHooks();
}
