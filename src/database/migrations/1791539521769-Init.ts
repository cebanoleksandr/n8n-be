import { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_WORKSPACE_ID } from '../../modules/workspaces/default-workspace.js';

export class Init1791539521769 implements MigrationInterface {
  name = 'Init1791539521769';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "workspaces" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "name" character varying(128) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_098656ae401f3e1a4586f47fd8e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "workflows" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workspace_id" uuid NOT NULL, "name" character varying(128) NOT NULL, "active" boolean NOT NULL DEFAULT false, "current_version_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5b5757cc1cd86268019fef52e0c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b0f4618d2a9269d50aef564cd0" ON "workflows"  ("workspace_id", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "workflow_versions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workflow_id" uuid NOT NULL, "version" integer NOT NULL, "graph" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_f9a22b7289b7461ead8b15c2708" UNIQUE ("workflow_id", "version"), CONSTRAINT "PK_a84eb8dc6065f33ce4b1447955f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "executions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workspace_id" uuid NOT NULL, "workflow_id" uuid NOT NULL, "workflow_version_id" uuid NOT NULL, "status" character varying(16) NOT NULL, "mode" character varying(16) NOT NULL, "error" jsonb, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_703e64e0ef651986191844b7b8b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_259e3a45941659c7ba04f17eb0" ON "executions"  ("workspace_id", "started_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3caaf789738b199b88346178a2" ON "executions"  ("workflow_id", "started_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "execution_steps" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "execution_id" uuid NOT NULL, "step_index" integer NOT NULL, "node_id" character varying(64) NOT NULL, "node_name" character varying(128) NOT NULL, "status" character varying(16) NOT NULL, "output" jsonb NOT NULL, "error" jsonb, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "finished_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_c04cbd28a0bbe6b7f7d17fa0abc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_34758e17fd6a03c1fcc171cf8a" ON "execution_steps"  ("execution_id", "step_index") `,
    );
    await queryRunner.query(
      `ALTER TABLE "workflows" ADD CONSTRAINT "FK_cff7dceda71edc109874a34a965" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workflow_versions" ADD CONSTRAINT "FK_535cc897570fe88cb9733411ecc" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_3f885f8a6ed181d5d7b20405dee" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_2a41dc8514e3d4610c6285c397f" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_90e77e4aa8edc2f83166ab28ad8" FOREIGN KEY ("workflow_version_id") REFERENCES "workflow_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "execution_steps" ADD CONSTRAINT "FK_97d4207c1ab909e0f21b74749a3" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `INSERT INTO "workspaces" ("id", "name") VALUES ($1, $2)`,
      [DEFAULT_WORKSPACE_ID, 'Default'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "execution_steps" DROP CONSTRAINT "FK_97d4207c1ab909e0f21b74749a3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_90e77e4aa8edc2f83166ab28ad8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_2a41dc8514e3d4610c6285c397f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_3f885f8a6ed181d5d7b20405dee"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workflow_versions" DROP CONSTRAINT "FK_535cc897570fe88cb9733411ecc"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workflows" DROP CONSTRAINT "FK_cff7dceda71edc109874a34a965"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_34758e17fd6a03c1fcc171cf8a"`,
    );
    await queryRunner.query(`DROP TABLE "execution_steps"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3caaf789738b199b88346178a2"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_259e3a45941659c7ba04f17eb0"`,
    );
    await queryRunner.query(`DROP TABLE "executions"`);
    await queryRunner.query(`DROP TABLE "workflow_versions"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b0f4618d2a9269d50aef564cd0"`,
    );
    await queryRunner.query(`DROP TABLE "workflows"`);
    await queryRunner.query(`DROP TABLE "workspaces"`);
  }
}
