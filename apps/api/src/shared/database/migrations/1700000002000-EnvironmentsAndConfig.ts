import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Where a contract is exercised, with what credentials, and under what configuration.
 *
 * This is the migration that finishes the decoupling at the storage level: after it, everything
 * the coupled dashboard held as literals across five modules — the fixtures, the payloads, the
 * RFP's latency table, the envelope map, the three credential fields — is a row somebody owns.
 */
export class EnvironmentsAndConfig1700000002000 implements MigrationInterface {
  name = "EnvironmentsAndConfig1700000002000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "environments" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(80) NOT NULL,
        "baseUrl" text NOT NULL,
        "specUrl" text,
        "variables" jsonb NOT NULL DEFAULT '{}'::jsonb,
        -- Closed by default. An environment that can be written to is a decision somebody makes,
        -- not a default they inherit: the first run against a production base URL must not be
        -- the one that discovers the flag was on.
        "writesAllowed" boolean NOT NULL DEFAULT false,
        "authEnforced" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_environments_project_name" ON "environments" ("projectId", "name")`);

    await queryRunner.query(`
      CREATE TABLE "environment_credentials" (
        "id" uuid PRIMARY KEY,
        "environmentId" uuid NOT NULL REFERENCES "environments"("id") ON DELETE CASCADE,
        "name" varchar(80) NOT NULL,
        "role" varchar(20) NOT NULL,
        "kind" varchar(40) NOT NULL,
        "headerName" varchar(80),
        "secretCiphertext" text NOT NULL,
        "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL
      )`);
    // One credential per role per environment: the generator asks for "the insufficient one",
    // and two rows answering to that would make which token a 403 case sends depend on row order.
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_credentials_environment_role" ON "environment_credentials" ("environmentId", "role")`);

    await queryRunner.query(`
      CREATE TABLE "project_config" (
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "section" varchar(40) NOT NULL,
        "data" jsonb NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL,
        PRIMARY KEY ("projectId", "section")
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "project_config"`);
    await queryRunner.query(`DROP TABLE "environment_credentials"`);
    await queryRunner.query(`DROP TABLE "environments"`);
  }
}
