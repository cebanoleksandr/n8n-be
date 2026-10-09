import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Env } from '../../config/env.js';
import { Cipher } from './cipher.js';
import { Credential } from './credential.entity.js';
import { CredentialsController } from './credentials.controller.js';
import { CredentialsService } from './credentials.service.js';
import { OAuth2Service } from './oauth2.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Credential])],
  controllers: [CredentialsController],
  providers: [
    CredentialsService,
    OAuth2Service,
    {
      provide: Cipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Cipher(config.get('ENCRYPTION_KEY', { infer: true })),
    },
  ],
  exports: [CredentialsService],
})
export class CredentialsModule {}
