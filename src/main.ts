import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { type Env, validateEnv } from './config/env.js';

async function bootstrap() {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on the real environment.
  }
  // The role decides which modules exist, so it is read before Nest starts.
  const role = validateEnv(process.env).APP_ROLE;
  const logger = new Logger('Bootstrap');

  if (role === 'worker') {
    const app = await NestFactory.createApplicationContext(
      AppModule.forRole(role),
    );
    app.enableShutdownHooks();
    logger.log('Running as worker');
    return;
  }

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRole(role),
  );
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  configureApp(
    app,
    config.get('CORS_ORIGINS', { infer: true }),
    config.get('TRUST_PROXY', { infer: true }),
  );

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Flow Platform API')
      .setVersion('0.3')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  logger.log(`Running as ${role} on port ${port}`);
}

await bootstrap();
