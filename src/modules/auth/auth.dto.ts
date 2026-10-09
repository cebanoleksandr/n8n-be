import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';
import type { Role } from './roles.js';

const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const password = z.string().min(8, 'must be at least 8 characters').max(256);
const name = z.string().trim().min(1).max(128);

export const setupSchema = z.object({
  email,
  name,
  password,
  workspaceName: z.string().trim().min(1).max(128).optional(),
});
export class SetupDto {
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiProperty({ minLength: 8 }) password: string;
  @ApiProperty({ required: false }) workspaceName?: string;
}

export const loginSchema = z.object({ email, password: z.string().max(256) });
export class LoginDto {
  @ApiProperty() email: string;
  @ApiProperty() password: string;
}

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(256),
  newPassword: password,
});
export class ChangePasswordDto {
  @ApiProperty() currentPassword: string;
  @ApiProperty({ minLength: 8 }) newPassword: string;
}

export const acceptInvitationSchema = z.object({
  /** Required for new accounts; ignored when the email already has one. */
  name: name.optional(),
  password,
});
export class AcceptInvitationDto {
  @ApiProperty({ required: false, description: 'Required for new accounts' })
  name?: string;
  @ApiProperty({
    minLength: 8,
    description:
      'New password, or the existing one if the email already has an account',
  })
  password: string;
}

export class UserDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
}

export class SessionDto {
  @ApiProperty() accessToken: string;
  @ApiProperty({ description: 'Seconds until the access token expires' })
  expiresIn: number;
  @ApiProperty({ type: UserDto }) user: UserDto;
}

export class MembershipDto {
  @ApiProperty() workspaceId: string;
  @ApiProperty() workspaceName: string;
  @ApiProperty() role: Role;
}

export class MeDto extends UserDto {
  @ApiProperty({ type: [MembershipDto] }) workspaces: MembershipDto[];
}
