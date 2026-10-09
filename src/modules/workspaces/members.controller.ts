import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Auth, MinRole } from '../auth/auth.decorators.js';
import { type AuthContext, type Role, ROLES } from '../auth/roles.js';
import { MembersService } from './members.service.js';

const renameSchema = z.object({ name: z.string().trim().min(1).max(128) });
const roleSchema = z.object({ role: z.enum(ROLES) });
const inviteSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  role: z.enum(ROLES),
});

/** The caller's current workspace (see X-Workspace-Id). */
@ApiTags('workspace')
@ApiBearerAuth()
@Controller('workspace')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  get(@Auth() auth: AuthContext) {
    return this.members.workspace(auth);
  }

  @Patch()
  @MinRole('admin')
  @ApiBody({ schema: { properties: { name: { type: 'string' } } } })
  rename(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(renameSchema)) dto: { name: string },
  ) {
    return this.members.rename(auth, dto.name);
  }

  @Get('members')
  list(@Auth() auth: AuthContext) {
    return this.members.list(auth);
  }

  @Patch('members/:userId')
  @MinRole('admin')
  @ApiBody({ schema: { properties: { role: { enum: [...ROLES] } } } })
  changeRole(
    @Auth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(roleSchema)) dto: { role: Role },
  ) {
    return this.members.changeRole(auth, userId, dto.role);
  }

  /** Admins remove others; any member may remove themselves (leave). */
  @Delete('members/:userId')
  @HttpCode(204)
  remove(
    @Auth() auth: AuthContext,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.members.remove(auth, userId);
  }

  @Get('invitations')
  @MinRole('admin')
  listInvitations(@Auth() auth: AuthContext) {
    return this.members.listInvitations(auth);
  }

  @Post('invitations')
  @MinRole('admin')
  @ApiBody({
    schema: {
      properties: { email: { type: 'string' }, role: { enum: [...ROLES] } },
    },
  })
  invite(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(inviteSchema))
    dto: { email: string; role: Role },
  ) {
    return this.members.invite(auth, dto.email, dto.role);
  }

  @Delete('invitations/:id')
  @MinRole('admin')
  @HttpCode(204)
  revokeInvitation(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.members.revokeInvitation(auth, id);
  }
}
