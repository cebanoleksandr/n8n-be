import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';
import { hasRole, type AuthContext, type Role } from '../auth/roles.js';
import { TokensService } from '../auth/tokens.service.js';
import { User } from '../auth/user.entity.js';
import { Invitation } from './invitation.entity.js';
import { WorkspaceMember } from './workspace-member.entity.js';
import { Workspace } from './workspace.entity.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: Date;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Admins manage viewers and editors; owners manage everyone. A workspace
 * always keeps at least one owner.
 */
@Injectable()
export class MembersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Workspace)
    private readonly workspaces: Repository<Workspace>,
    @InjectRepository(WorkspaceMember)
    private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(Invitation)
    private readonly invitations: Repository<Invitation>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly tokens: TokensService,
  ) {}

  async workspace(auth: AuthContext) {
    const ws = await this.workspaces.findOneByOrFail({ id: auth.workspaceId });
    return { id: ws.id, name: ws.name, role: auth.role };
  }

  async rename(auth: AuthContext, name: string) {
    await this.workspaces.update(auth.workspaceId, { name });
    return this.workspace(auth);
  }

  async list(auth: AuthContext): Promise<MemberDto[]> {
    const members = await this.members.find({
      where: { workspaceId: auth.workspaceId },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    return members.map((m) => ({
      userId: m.userId,
      email: m.user!.email,
      name: m.user!.name,
      role: m.role,
      joinedAt: m.createdAt,
    }));
  }

  async changeRole(
    auth: AuthContext,
    userId: string,
    role: Role,
  ): Promise<MemberDto[]> {
    await this.dataSource.transaction(async (em) => {
      const member = await this.lockMember(
        em.getRepository(WorkspaceMember),
        auth,
        userId,
      );
      assertCanManage(auth, member.role);
      assertCanGrant(auth, role);
      if (member.role === 'owner' && role !== 'owner') {
        await assertNotLastOwner(
          em.getRepository(WorkspaceMember),
          auth.workspaceId,
        );
      }
      await em.update(
        WorkspaceMember,
        { workspaceId: auth.workspaceId, userId },
        { role },
      );
    });
    return this.list(auth);
  }

  /** Removes a member; anyone may leave themselves (unless last owner). */
  async remove(auth: AuthContext, userId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      const repo = em.getRepository(WorkspaceMember);
      const member = await this.lockMember(repo, auth, userId);
      if (userId !== auth.userId) assertCanManage(auth, member.role);
      if (member.role === 'owner')
        await assertNotLastOwner(repo, auth.workspaceId);
      await repo.delete({ workspaceId: auth.workspaceId, userId });
    });
  }

  async listInvitations(auth: AuthContext): Promise<InvitationDto[]> {
    const invitations = await this.invitations.find({
      where: {
        workspaceId: auth.workspaceId,
        acceptedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: 'DESC' },
    });
    return invitations.map(toInvitationDto);
  }

  /**
   * Returns the raw token once; only its hash is stored. Email delivery is
   * not built yet, so the caller shares the link.
   */
  async invite(
    auth: AuthContext,
    email: string,
    role: Role,
  ): Promise<InvitationDto & { token: string }> {
    assertCanGrant(auth, role);
    const user = await this.users.findOneBy({ email });
    if (
      user &&
      (await this.members.existsBy({
        workspaceId: auth.workspaceId,
        userId: user.id,
      }))
    ) {
      throw new ConflictException(`${email} is already a member`);
    }
    // A new invitation replaces any pending one for the same email.
    await this.invitations.delete({
      workspaceId: auth.workspaceId,
      email,
      acceptedAt: IsNull(),
    });
    const { token, hash } = this.tokens.newOpaqueToken();
    const invitation = await this.invitations.save(
      this.invitations.create({
        workspaceId: auth.workspaceId,
        email,
        role,
        tokenHash: hash,
        invitedBy: auth.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        acceptedAt: null,
      }),
    );
    return { ...toInvitationDto(invitation), token };
  }

  async revokeInvitation(auth: AuthContext, id: string): Promise<void> {
    const result = await this.invitations.delete({
      id,
      workspaceId: auth.workspaceId,
      acceptedAt: IsNull(),
    });
    if (!result.affected) throw new NotFoundException('Invitation not found');
  }

  private async lockMember(
    repo: Repository<WorkspaceMember>,
    auth: AuthContext,
    userId: string,
  ): Promise<WorkspaceMember> {
    const member = await repo.findOne({
      where: { workspaceId: auth.workspaceId, userId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }
}

function assertCanManage(auth: AuthContext, targetRole: Role): void {
  if (!hasRole(auth.role, 'admin'))
    throw new ForbiddenException('Requires the admin role');
  if (hasRole(targetRole, 'admin') && auth.role !== 'owner') {
    throw new ForbiddenException('Only owners can manage admins and owners');
  }
}

function assertCanGrant(auth: AuthContext, role: Role): void {
  if (hasRole(role, 'admin') && auth.role !== 'owner') {
    throw new ForbiddenException(
      'Only owners can grant the admin or owner role',
    );
  }
}

async function assertNotLastOwner(
  repo: Repository<WorkspaceMember>,
  workspaceId: string,
): Promise<void> {
  const owners = await repo.countBy({ workspaceId, role: 'owner' });
  if (owners <= 1) {
    throw new BadRequestException('A workspace must keep at least one owner');
  }
}

function toInvitationDto(i: Invitation): InvitationDto {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
  };
}
