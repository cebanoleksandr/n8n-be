import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';
import type {
  WebhookMethod,
  WebhookResponseMode,
} from '../../nodes/core/webhook.node.js';
import { Workflow } from '../workflows/workflow.entity.js';

/**
 * Routing table for live webhooks. Rows exist only while the workflow is
 * active and are rebuilt from the graph on every activation or save.
 */
@Entity('webhooks')
@Unique(['method', 'path'])
@Index(['workflowId'])
export class Webhook {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow?: Relation<Workflow>;

  @Column({ name: 'node_id', type: 'varchar', length: 64 })
  nodeId: string;

  @Column({ type: 'varchar', length: 8 })
  method: WebhookMethod;

  @Column({ type: 'varchar', length: 255 })
  path: string;

  @Column({ name: 'response_mode', type: 'varchar', length: 16 })
  responseMode: WebhookResponseMode;
}
