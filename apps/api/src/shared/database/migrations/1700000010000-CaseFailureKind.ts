import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * De quién es el fallo, en una columna.
 *
 * A run of 311 cases with 40 in red is a list nobody reads: every row costs the same to triage as
 * the last one. `failure` is what makes it sortable — a target that answered 5xx, a response whose
 * shape broke its own contract, and a run that never left because a variable was missing are three
 * different conversations with three different people, and until now they were the same colour.
 *
 * A column rather than something derived when the run is read: it is what a list is *counted* by,
 * and recomputing it per row per page view means re-reading every step of every case.
 *
 * Nothing backfills. The old rows keep their assertions, which is where the answer was before and
 * still is; inventing a classification for them from a heuristic would put a label on evidence
 * without having looked at it, which is the one thing this product exists to argue against.
 */
export class CaseFailureKind1700000010000 implements MigrationInterface {
  name = "CaseFailureKind1700000010000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "run_cases" ADD COLUMN "failure" varchar(20)`);
    // Partial: only failed rows ever carry one, and they are the minority of a healthy history.
    await queryRunner.query(
      `CREATE INDEX "IDX_run_cases_failure" ON "run_cases" ("runId", "failure") WHERE "failure" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_run_cases_failure"`);
    await queryRunner.query(`ALTER TABLE "run_cases" DROP COLUMN "failure"`);
  }
}
