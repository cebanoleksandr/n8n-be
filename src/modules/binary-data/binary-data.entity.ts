import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { Execution } from '../executions/execution.entity.js';
import { Workflow } from '../workflows/workflow.entity.js';
import { Workspace } from '../workspaces/workspace.entity.js';

/**
 * Metadata of a file in object storage. Deleting the workflow nulls
 * workflow_id; the cleanup job then removes the object and the row.
 */
@Entity('binary_data')
@Index(['workflowId'])
export class BinaryData {
  /** Also the object key suffix: <workspaceId>/<id>. */
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @ManyToOne(() => Workspace, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace?: Relation<Workspace>;

  @Column({ name: 'workflow_id', type: 'uuid', nullable: true })
  workflowId: string | null;

  @ManyToOne(() => Workflow, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'workflow_id' })
  workflow?: Relation<Workflow>;

  /** Null for files received by a webhook before the execution existed. */
  @Column({ name: 'execution_id', type: 'uuid', nullable: true })
  executionId: string | null;

  @ManyToOne(() => Execution, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'execution_id' })
  execution?: Relation<Execution>;

  @Column({ name: 'file_name', type: 'varchar', length: 255, nullable: true })
  fileName: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 255 })
  mimeType: string;

  @Column({ type: 'int' })
  size: number;

  @Column({ name: 'storage_key', type: 'varchar', length: 512 })
  storageKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
