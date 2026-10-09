import { Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { ExecutionEventsService } from './execution-events.service.js';

const subscriptionSchema = z
  .object({ workflowId: z.uuid().optional(), executionId: z.uuid().optional() })
  .refine(
    (v) => v.workflowId || v.executionId,
    'workflowId or executionId is required',
  );

type Ack = { ok: true } | { ok: false; error: string };

/**
 * socket.io namespace `/executions`.
 *
 *   socket.emit('subscribe', { workflowId }, ack)   // or { executionId }
 *   socket.on('execution-event', (event) => ...)
 */
@WebSocketGateway({ namespace: 'executions' })
export class RealtimeGateway implements OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private stopRelay?: () => void;

  @WebSocketServer()
  private readonly server: Namespace;

  constructor(private readonly events: ExecutionEventsService) {}

  async afterInit(): Promise<void> {
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
    const rooms = roomsFor(body);
    if (typeof rooms === 'string') return { ok: false, error: rooms };
    await client.join(rooms);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack> {
    const rooms = roomsFor(body);
    if (typeof rooms === 'string') return { ok: false, error: rooms };
    for (const room of rooms) await client.leave(room);
    return { ok: true };
  }
}

function roomsFor(body: unknown): string[] | string {
  const parsed = subscriptionSchema.safeParse(body);
  if (!parsed.success)
    return parsed.error.issues.map((i) => i.message).join('; ');
  const { workflowId, executionId } = parsed.data;
  return [
    ...(workflowId ? [`workflow:${workflowId}`] : []),
    ...(executionId ? [`execution:${executionId}`] : []),
  ];
}

@Module({ providers: [RealtimeGateway] })
export class RealtimeModule {}
