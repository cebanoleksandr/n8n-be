import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type Relation,
} from 'typeorm';
import { Workspace } from '../workspaces/workspace.entity.js';

/** Workflow-level settings; not versioned with the graph. */
export interface WorkflowSettings {
  /** Workflow (with an Error Trigger) started when a non-manual run fails. */
  errorWorkflowId?: string;
  /** Abort runs that take longer; capped by EXECUTION_TIMEOUT_MAX_SECONDS. */
  timeoutSeconds?: number;
}

@Entity('workflows')
@Index(['workspaceId', 'updatedAt'])
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace?: Relation<Workspace>;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  /** Whether triggers (webhook, cron) are live. Manual runs work regardless. */
  @Column({ type: 'boolean', default: false })
  active: boolean;

  /**
   * Latest version. Deliberately no FK: workflow_versions already references
   * workflows, and a cycle of FKs complicates inserts and deletes.
   */
  @Column({ name: 'current_version_id', type: 'uuid', nullable: true })
  currentVersionId: string | null;

  @Column({ type: 'jsonb', default: {} })
  settings: WorkflowSettings;

  /**
   * Editor test data: node id -> JSON items used instead of executing that
   * node in manual runs. Not versioned; production runs ignore it.
   */
  @Column({ name: 'pin_data', type: 'jsonb', default: {} })
  pinData: Record<string, Record<string, unknown>[]>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
