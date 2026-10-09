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
import { Execution } from './execution.entity.js';

/**
 * Stored shape of an engine Item. Kept non-recursive on purpose: TypeORM's
 * deep-partial types blow up on the recursive JsonValue type.
 */
export interface StoredItem {
  json: Record<string, unknown>;
}

/** Result of one node within an execution. Output can be large: load it only when needed. */
@Entity('execution_steps')
@Index(['executionId', 'stepIndex'])
export class ExecutionStep {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'execution_id', type: 'uuid' })
  executionId: string;

  @ManyToOne(() => Execution, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'execution_id' })
  execution?: Relation<Execution>;

  /** Order in which nodes ran. */
  @Column({ name: 'step_index', type: 'int' })
  stepIndex: number;

  @Column({ name: 'node_id', type: 'varchar', length: 64 })
  nodeId: string;

  @Column({ name: 'node_name', type: 'varchar', length: 128 })
  nodeName: string;

  @Column({ type: 'varchar', length: 16 })
  status: 'success' | 'error';

  /** One item array per node output. */
  @Column({ type: 'jsonb' })
  output: StoredItem[][];

  @Column({ type: 'jsonb', nullable: true })
  error: SerializedError | null;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  @Column({ name: 'finished_at', type: 'timestamptz' })
  finishedAt: Date;
}
