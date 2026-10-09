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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
