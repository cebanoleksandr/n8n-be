import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  type Relation,
} from 'typeorm';
import type { WorkflowGraph } from '../../engine/types.js';
import { Workflow } from './workflow.entity.js';

/**
 * Snapshot of a workflow graph. Executions always reference a version. What
 * runs never changes: a new version is made for that. Only node positions
 * (layout) are updated in place, so moving nodes does not pile up versions.
 */
@Entity('workflow_versions')
@Unique(['workflowId', 'version'])
export class WorkflowVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workflow_id', type: 'uuid' })
  workflowId: string;

  @ManyToOne(() => Workflow, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workflow_id' })
  workflow?: Relation<Workflow>;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'jsonb' })
  graph: WorkflowGraph;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
