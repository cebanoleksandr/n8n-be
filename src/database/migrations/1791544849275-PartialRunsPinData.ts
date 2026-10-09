import { MigrationInterface, QueryRunner } from 'typeorm';

export class PartialRunsPinData1791544849275 implements MigrationInterface {
  name = 'PartialRunsPinData1791544849275';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflows" ADD "pin_data" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(`ALTER TABLE "executions" ADD "run_options" jsonb`);
    await queryRunner.query(
      `ALTER TABLE "execution_steps" ADD "pinned" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bcab40c4106daf3d1806504130" ON "executions"  ("finished_at") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bcab40c4106daf3d1806504130"`,
    );
    await queryRunner.query(
      `ALTER TABLE "execution_steps" DROP COLUMN "pinned"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN "run_options"`,
    );
    await queryRunner.query(`ALTER TABLE "workflows" DROP COLUMN "pin_data"`);
  }
}
