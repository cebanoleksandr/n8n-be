import { MigrationInterface, QueryRunner } from 'typeorm';

export class TriggersCredentialsQueue1791540619770 implements MigrationInterface {
  name = 'TriggersCredentialsQueue1791540619770';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_259e3a45941659c7ba04f17eb0"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3caaf789738b199b88346178a2"`,
    );
    await queryRunner.query(
      `CREATE TABLE "credentials" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workspace_id" uuid NOT NULL, "name" character varying(128) NOT NULL, "type" character varying(64) NOT NULL, "data" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_1e38bc43be6697cdda548ad27a6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_be2b4bf511a2c6c81c12c42d1d" ON "credentials"  ("workspace_id", "type") `,
    );
    await queryRunner.query(
      `CREATE TABLE "webhooks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workflow_id" uuid NOT NULL, "node_id" character varying(64) NOT NULL, "method" character varying(8) NOT NULL, "path" character varying(255) NOT NULL, "response_mode" character varying(16) NOT NULL, CONSTRAINT "UQ_16a592e379fe580aaeff3acc735" UNIQUE ("method", "path"), CONSTRAINT "PK_9e8795cfc899ab7bdaa831e8527" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4314c453aaa8320bc3f908639c" ON "webhooks"  ("workflow_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD "start_node_id" character varying(64)`,
    );
    await queryRunner.query(`ALTER TABLE "executions" ADD "input" jsonb`);
    await queryRunner.query(
      `ALTER TABLE "executions" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    // Existing rows were created when they started.
    await queryRunner.query(
      `UPDATE "executions" SET "created_at" = "started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ALTER COLUMN "started_at" DROP NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_55584e50acd723e9e82475e17d" ON "executions"  ("workspace_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_692fb0f653e980df8672e06e67" ON "executions"  ("workflow_id", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "credentials" ADD CONSTRAINT "FK_651b3a0c59cff4a55823bdc159f" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhooks" ADD CONSTRAINT "FK_4314c453aaa8320bc3f908639c6" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhooks" DROP CONSTRAINT "FK_4314c453aaa8320bc3f908639c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "credentials" DROP CONSTRAINT "FK_651b3a0c59cff4a55823bdc159f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_692fb0f653e980df8672e06e67"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_55584e50acd723e9e82475e17d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ALTER COLUMN "started_at" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN "created_at"`,
    );
    await queryRunner.query(`ALTER TABLE "executions" DROP COLUMN "input"`);
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN "start_node_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4314c453aaa8320bc3f908639c"`,
    );
    await queryRunner.query(`DROP TABLE "webhooks"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_be2b4bf511a2c6c81c12c42d1d"`,
    );
    await queryRunner.query(`DROP TABLE "credentials"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_3caaf789738b199b88346178a2" ON "executions" USING btree ("started_at", "workflow_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_259e3a45941659c7ba04f17eb0" ON "executions" USING btree ("started_at", "workspace_id") `,
    );
  }
}
