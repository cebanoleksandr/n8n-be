import { MigrationInterface, QueryRunner } from 'typeorm';

export class SubworkflowsAndWaits1791548795661 implements MigrationInterface {
  name = 'SubworkflowsAndWaits1791548795661';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executions" ADD "parent_execution_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD "depth" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD "wait_till" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "executions" ADD "wait_state" jsonb`);
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_6bcba1a732e88900997f8bc3b11" FOREIGN KEY ("parent_execution_id") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_6bcba1a732e88900997f8bc3b11"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN "wait_state"`,
    );
    await queryRunner.query(`ALTER TABLE "executions" DROP COLUMN "wait_till"`);
    await queryRunner.query(`ALTER TABLE "executions" DROP COLUMN "depth"`);
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN "parent_execution_id"`,
    );
  }
}
