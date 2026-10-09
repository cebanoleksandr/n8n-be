import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from 'typeorm';
import type { SerializedError } from '../../engine/workflow-runner.js';
import { WorkflowVersion } from '../workflows/workflow-version.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';
import { Workspace } from '../workspaces/workspace.entity.js';

export type ExecutionStatus = 'running' | 'success' | 'error' | 'canceled';
export type ExecutionMode = 'manual';

@Entity('executions')
@Index(['workflowId', 'startedAt'])
@Index(['workspaceId', 'startedAt'])
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

  @Column({ type: 'jsonb', nullable: true })
  error: (SerializedError & { nodeId?: string }) | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;
}
