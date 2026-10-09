import { MigrationInterface, QueryRunner } from 'typeorm';

export class BinaryDataRetriesSettings1791542979945 implements MigrationInterface {
  name = 'BinaryDataRetriesSettings1791542979945';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "binary_data" ("id" uuid NOT NULL, "workspace_id" uuid NOT NULL, "workflow_id" uuid, "execution_id" uuid, "file_name" character varying(255), "mime_type" character varying(255) NOT NULL, "size" integer NOT NULL, "storage_key" character varying(512) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_f386b0eaae8b0c421a59ef48a47" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_663731e07d0d3a7b1d595a8acc" ON "binary_data"  ("workflow_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "workflows" ADD "settings" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "execution_steps" ADD "tries" integer NOT NULL DEFAULT '1'`,
    );
    await queryRunner.query(
      `ALTER TABLE "binary_data" ADD CONSTRAINT "FK_104f5b17cbb16cf90ad5a85080d" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "binary_data" ADD CONSTRAINT "FK_663731e07d0d3a7b1d595a8accc" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "binary_data" ADD CONSTRAINT "FK_08fa777d1c5f97a21932a4f3304" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "binary_data" DROP CONSTRAINT "FK_08fa777d1c5f97a21932a4f3304"`,
    );
    await queryRunner.query(
      `ALTER TABLE "binary_data" DROP CONSTRAINT "FK_663731e07d0d3a7b1d595a8accc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "binary_data" DROP CONSTRAINT "FK_104f5b17cbb16cf90ad5a85080d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "execution_steps" DROP COLUMN "tries"`,
    );
    await queryRunner.query(`ALTER TABLE "workflows" DROP COLUMN "settings"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_663731e07d0d3a7b1d595a8acc"`,
    );
    await queryRunner.query(`DROP TABLE "binary_data"`);
  }
}
