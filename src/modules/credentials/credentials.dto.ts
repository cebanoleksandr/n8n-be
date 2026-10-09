import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const dataSchema = z.record(z.string(), z.unknown());

export const createCredentialSchema = z.object({
  name: z.string().trim().min(1).max(128),
  type: z.string().min(1).max(64),
  data: dataSchema,
});

export class CreateCredentialDto implements z.infer<
  typeof createCredentialSchema
> {
  @ApiProperty({ maxLength: 128 }) name: string;
  @ApiProperty({ example: 'httpBearerAuth' }) type: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { token: 'secret' },
  })
  data: Record<string, unknown>;
}

export const updateCredentialSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    data: dataSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export class UpdateCredentialDto implements z.infer<
  typeof updateCredentialSchema
> {
  @ApiPropertyOptional({ maxLength: 128 }) name?: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Merged into the stored data: omitted fields keep their values',
  })
  data?: Record<string, unknown>;
}

export class CredentialDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() type: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Non-secret fields only',
  })
  data: Record<string, unknown>;
  @ApiPropertyOptional({
    description: 'OAuth2 credentials only: whether tokens are stored',
    example: { connected: true, expiresAt: '2026-10-09T12:00:00.000Z' },
  })
  oauth2?: { connected: boolean; expiresAt: Date | null };
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
