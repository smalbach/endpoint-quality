import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Runs, their cases and their steps.
 *
 * The coupled dashboard kept results in React state: closing the tab lost them, and "was this
 * green last week" had no answer. Rows give history, trend and evidence — and they move the
 * execution loop off the browser, which is what lets a run started from CI and one started from
 * the UI be the same thing.
 */
export class Runs1700000003000 implements MigrationInterface {
  name = "Runs1700000003000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "runs" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "environmentId" uuid REFERENCES "environments"("id") ON DELETE SET NULL,
        "specVersionId" uuid NOT NULL REFERENCES "spec_versions"("id") ON DELETE RESTRICT,
        "status" varchar(20) NOT NULL,
        "plan" jsonb NOT NULL,
        "totals" jsonb NOT NULL,
        "triggeredByKind" varchar(20) NOT NULL,
        "triggeredBy" uuid NOT NULL,
        "startedAt" timestamptz NOT NULL,
        "finishedAt" timestamptz,
        "error" text
      )`);
    // The history view is "this project's runs, newest first", and it is the only query anybody
    // makes against this table often.
    await queryRunner.query(`CREATE INDEX "ix_runs_project_started" ON "runs" ("projectId", "startedAt" DESC)`);

    await queryRunner.query(`
      CREATE TABLE "run_cases" (
        "id" uuid PRIMARY KEY,
        "runId" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
        "operationId" varchar(200) NOT NULL,
        "scenarioId" varchar(200) NOT NULL,
        "method" varchar(10) NOT NULL,
        "path" text NOT NULL,
        "status" varchar(20) NOT NULL,
        "position" int NOT NULL,
        "durationMs" int,
        "startedAt" timestamptz,
        "finishedAt" timestamptz
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_run_cases_run_position" ON "run_cases" ("runId", "position")`);
    await queryRunner.query(`CREATE INDEX "ix_run_cases_run_status" ON "run_cases" ("runId", "status")`);

    await queryRunner.query(`
      CREATE TABLE "run_steps" (
        "id" uuid PRIMARY KEY,
        "runCaseId" uuid NOT NULL REFERENCES "run_cases"("id") ON DELETE CASCADE,
        "index" int NOT NULL,
        "purpose" varchar(20) NOT NULL,
        "label" varchar(200) NOT NULL,
        "request" jsonb NOT NULL,
        "expected" jsonb NOT NULL,
        "actual" jsonb,
        "assertions" jsonb NOT NULL,
        "latency" jsonb,
        "ok" boolean NOT NULL,
        "durationMs" int NOT NULL
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_run_steps_case_index" ON "run_steps" ("runCaseId", "index")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "run_steps"`);
    await queryRunner.query(`DROP TABLE "run_cases"`);
    await queryRunner.query(`DROP TABLE "runs"`);
  }
}
