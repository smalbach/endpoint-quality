import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Makes a step's bodies removable without removing the step.
 *
 * `run_steps` is the table that grows: a `create-read` case is three rows and each holds a whole
 * response body, so a nightly matrix of 311 cases writes hundreds of them a day and nothing ever
 * took any away. Left alone it is the one part of this system with no ceiling.
 *
 * The bodies are what weigh; the verdict is not. An assertion list, a label and a duration are a
 * few hundred bytes and they are what makes a run from March still answer «was this green, and
 * what failed». So retention has two stages, and this migration is what allows the first: the
 * three payload columns become nullable and `prunedAt` records when they were emptied.
 *
 * `prunedAt` rather than an empty object, because the two are different facts. A step whose
 * `actual` is null because nothing came back is a timeout; a step whose `actual` is null because
 * the bodies were retired six months later is a completed request. A reader that cannot tell them
 * apart eventually reports the second as the first.
 */
export class Retention1700000005000 implements MigrationInterface {
  name = "Retention1700000005000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "run_steps" ALTER COLUMN "request" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "run_steps" ALTER COLUMN "expected" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "run_steps" ADD COLUMN "prunedAt" timestamptz`);
    // The sweep reads `runs.finishedAt` and then deletes through the case rows, so the index it
    // needs is on the run's own end time. Without it every sweep is a sequential scan of every
    // run ever executed, which is exactly the table this is meant to keep from mattering.
    await queryRunner.query(`CREATE INDEX "idx_runs_finished_at" ON "runs" ("finishedAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_runs_finished_at"`);
    await queryRunner.query(`ALTER TABLE "run_steps" DROP COLUMN "prunedAt"`);
    // Rows emptied by a sweep have no body to restore, so they are given an empty one: the column
    // has to be NOT NULL again and there is nothing truthful to put there. Going back past a
    // retention sweep loses the distinction the sweep recorded, which is a reason to run `down`
    // for a mistake made minutes ago and not for one made months ago.
    await queryRunner.query(`UPDATE "run_steps" SET "request" = '{}'::jsonb WHERE "request" IS NULL`);
    await queryRunner.query(`UPDATE "run_steps" SET "expected" = '{}'::jsonb WHERE "expected" IS NULL`);
    await queryRunner.query(`ALTER TABLE "run_steps" ALTER COLUMN "request" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "run_steps" ALTER COLUMN "expected" SET NOT NULL`);
  }
}
