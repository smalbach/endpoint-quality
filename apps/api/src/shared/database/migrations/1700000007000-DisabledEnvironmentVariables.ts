import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A variable can be switched off without being lost.
 *
 * The editor had no way to say «keep this, stop applying it»: the only way to stop substituting a
 * value was to delete it, so people kept a copy in a note somewhere. The parked ones live in
 * their own column rather than as a flag inside `variables`, because `variables` is read straight
 * into the run as the substitution map — a flag there would mean every reader has to filter, and
 * the first one that forgets sends a value somebody deliberately turned off.
 */
export class DisabledEnvironmentVariables1700000007000 implements MigrationInterface {
  name = "DisabledEnvironmentVariables1700000007000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "environments" ADD COLUMN "disabledVariables" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the column drops the parked values with it. That is the honest reversal: they were
    // never applied to anything, so there is nowhere in the old shape to put them.
    await queryRunner.query(`ALTER TABLE "environments" DROP COLUMN "disabledVariables"`);
  }
}
