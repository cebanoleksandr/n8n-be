import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  configureApp(app);
  app.enableCors({ origin: config.get('CORS_ORIGINS', { infer: true }) });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Flow Platform API')
      .setVersion('0.1')
      .build(),
  );
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  await app.listen(config.get('PORT', { infer: true }));
}

await bootstrap();
