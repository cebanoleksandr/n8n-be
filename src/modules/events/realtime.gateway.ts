import { Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { In, Repository } from 'typeorm';
import { z } from 'zod';
import { AuthModule } from '../auth/auth.module.js';
import { TokensService } from '../auth/tokens.service.js';
import { Execution } from '../executions/execution.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';
import { WorkspaceMember } from '../workspaces/workspace-member.entity.js';
import { ExecutionEventsService } from './execution-events.service.js';

const subscriptionSchema = z
  .object({ workflowId: z.uuid().optional(), executionId: z.uuid().optional() })
  .refine(
    (v) => v.workflowId || v.executionId,
    'workflowId or executionId is required',
  );

type Ack = { ok: true } | { ok: false; error: string };

interface SocketData {
  userId: string;
}

/**
 * socket.io namespace `/executions`.
 *
 *   const socket = io('/executions', { auth: { token: accessToken } });
 *   socket.emit('subscribe', { workflowId }, ack)   // or { executionId }
 *   socket.on('execution-event', (event) => ...)
 *
 * The token is checked once on connect; reconnect with a fresh token after it
 * expires. Every subscription is checked against the user's workspaces.
 */
@WebSocketGateway({ namespace: 'executions' })
export class RealtimeGateway implements OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private stopRelay?: () => void;

  @WebSocketServer()
  private readonly server: Namespace;

  constructor(
    private readonly events: ExecutionEventsService,
    private readonly tokens: TokensService,
    @InjectRepository(WorkspaceMember)
    private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(Workflow)
    private readonly workflows: Repository<Workflow>,
    @InjectRepository(Execution)
    private readonly executions: Repository<Execution>,
  ) {}

  async afterInit(server: Namespace): Promise<void> {
    // Runs before the connection is established: unauthenticated sockets never connect.
    server.use((socket, next) => {
      const token: unknown = (socket.handshake.auth as { token?: unknown })
        .token;
      try {
        if (typeof token !== 'string') throw new Error('Missing token');
        (socket.data as SocketData).userId = this.tokens.verifyAccess(token);
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
    this.stopRelay = await this.events.subscribe((event) => {
      this.server
        .to([`workflow:${event.workflowId}`, `execution:${event.executionId}`])
        .emit('execution-event', event);
    });
    this.logger.log('Relaying execution events over WebSocket');
  }

  onModuleDestroy(): void {
    this.stopRelay?.();
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const parsed = subscriptionSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }
    const { workflowId, executionId } = parsed.data;
    const userId = (client.data as SocketData).userId;
    const allowed = await this.canAccess(userId, workflowId, executionId);
    if (!allowed) return { ok: false, error: 'Not found' };
    await client.join(roomsFor(workflowId, executionId));
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const parsed = subscriptionSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'Invalid subscription' };
    for (const room of roomsFor(
      parsed.data.workflowId,
      parsed.data.executionId,
    )) {
      await client.leave(room);
    }
    return { ok: true };
  }

  /** Same answer for "missing" and "not yours", so ids cannot be probed. */
  private async canAccess(
    userId: string,
    workflowId?: string,
    executionId?: string,
  ): Promise<boolean> {
    const workspaceIds = (await this.members.findBy({ userId })).map(
      (m) => m.workspaceId,
    );
    if (workspaceIds.length === 0) return false;
    const inWorkspaces = { workspaceId: In(workspaceIds) };
    if (
      workflowId &&
      !(await this.workflows.existsBy({ id: workflowId, ...inWorkspaces }))
    ) {
      return false;
    }
    if (
      executionId &&
      !(await this.executions.existsBy({ id: executionId, ...inWorkspaces }))
    ) {
      return false;
    }
    return true;
  }
}

function roomsFor(workflowId?: string, executionId?: string): string[] {
  return [
    ...(workflowId ? [`workflow:${workflowId}`] : []),
    ...(executionId ? [`execution:${executionId}`] : []),
  ];
}

@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([Workflow, Execution])],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
