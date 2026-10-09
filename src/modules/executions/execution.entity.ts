import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import type { SerializedError } from '../../engine/workflow-runner.js';
import type { StoredItem } from './execution-step.entity.js';
import { WorkflowVersion } from '../workflows/workflow-version.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';
import { Workspace } from '../workspaces/workspace.entity.js';

export const EXECUTION_STATUSES = [
  'queued',
  'running',
  'success',
  'error',
  'canceled',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const EXECUTION_MODES = [
  'manual',
  'webhook',
  'schedule',
  /** Started by an Error Trigger because another run failed. */
  'error',
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isFinished(status: ExecutionStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

@Entity('executions')
@Index(['workflowId', 'createdAt'])
@Index(['workspaceId', 'createdAt'])
export class Execution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace?: Relation<Workspace>;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow?: Relation<Workflow>;

  @Column({ name: 'workflow_version_id', type: 'uuid' })
  workflowVersionId: string;

  @ManyToOne(() => WorkflowVersion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_version_id' })
  workflowVersion?: Relation<WorkflowVersion>;

  @Column({ type: 'varchar', length: 16 })
  status: ExecutionStatus;

  @Column({ type: 'varchar', length: 16 })
  mode: ExecutionMode;

  /** Trigger node the run starts from; null means the first trigger. */
  @Column({
    name: 'start_node_id',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  startNodeId: string | null;

  /** Items handed to the trigger node (webhook request, schedule tick, manual input). */
  @Column({ type: 'jsonb', nullable: true })
  input: StoredItem[] | null;

  @Column({ type: 'jsonb', nullable: true })
  error: (SerializedError & { nodeId?: string }) | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
