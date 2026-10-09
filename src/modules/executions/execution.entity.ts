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
  /** Paused by a Wait node until wait_till. */
  'waiting',
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
  /** Called by an Execute Workflow node. */
  'subworkflow',
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface ExecutionRunOptions {
  destinationNodeId?: string;
  runFromNodeId?: string;
  /** Resolved when the run is created, so it is fixed even if newer runs finish. */
  sourceExecutionId?: string;
}

export function isFinished(status: ExecutionStatus): boolean {
  return status !== 'queued' && status !== 'running' && status !== 'waiting';
}

@Entity('executions')
@Index(['workflowId', 'createdAt'])
@Index(['workspaceId', 'createdAt'])
@Index(['finishedAt'])
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

  /** For sub-workflow runs: the execution whose Execute Workflow node started it. */
  @Column({ name: 'parent_execution_id', type: 'uuid', nullable: true })
  parentExecutionId: string | null;

  @ManyToOne(() => Execution, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'parent_execution_id' })
  parentExecution?: Relation<Execution>;

  /** Sub-workflow nesting level (0 for top-level runs). */
  @Column({ type: 'int', default: 0 })
  depth: number;

  /** Partial-run options of manual runs (see RunWorkflowDto). */
  @Column({ name: 'run_options', type: 'jsonb', nullable: true })
  runOptions: ExecutionRunOptions | null;

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

  /** status 'waiting': when the Wait node resumes. */
  @Column({ name: 'wait_till', type: 'timestamptz', nullable: true })
  waitTill: Date | null;

  /**
   * status 'waiting': the engine's RunState (node outputs so far). Typed as
   * opaque JSON because TypeORM's update types cannot handle the item type.
   */
  @Column({ name: 'wait_state', type: 'jsonb', nullable: true })
  waitState: Record<string, unknown> | null;
}
