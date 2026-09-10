import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A variable stops being a string and becomes three fields.
 *
 * `{ initial, current, sensitive }`, in place, in both columns. Two of them are the reason:
 *
 * - **initial vs current.** One value per name meant that debugging with a throwaway token
 *   rewrote what everybody else pulls. `initial` is the shared value; `current` is what this
 *   run substitutes, and it is what a capture overwrites.
 * - **sensitive.** A staging token pasted into a variable was plain text in a `jsonb` column and
 *   in every response that listed the environment. Marked sensitive it is AES-256-GCM ciphertext
 *   here and eight dots on the wire.
 *
 * Nothing is encrypted by this migration: every existing value moves across as `sensitive: false`,
 * because guessing which of them were secrets would be wrong in both directions — a value marked
 * sensitive by a heuristic is a value nobody can read back, and one missed is a false promise.
 * Whoever knows which is which ticks the box in the editor, and that write encrypts it.
 */
export class SensitiveEnvironmentVariables1700000008000 implements MigrationInterface {
  name = "SensitiveEnvironmentVariables1700000008000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of ["variables", "disabledVariables"]) {
      await queryRunner.query(
        `UPDATE "environments" SET "${column}" = coalesce(
           (SELECT jsonb_object_agg(key, jsonb_build_object('initial', value, 'current', value, 'sensitive', false))
              FROM jsonb_each_text("${column}")),
           '{}'::jsonb)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Back to one string per name, and `current` is the one that survives: it is what the runs
    // were substituting, so keeping `initial` instead would quietly revert every value that had
    // been changed since. **A sensitive value goes back as ciphertext**, which the old shape has
    // no way to mark — that is the honest reversal, and the reason this direction is a last
    // resort rather than a routine one.
    for (const column of ["variables", "disabledVariables"]) {
      await queryRunner.query(
        `UPDATE "environments" SET "${column}" = coalesce(
           (SELECT jsonb_object_agg(key, coalesce(nullif(value->>'current', ''), value->>'initial', ''))
              FROM jsonb_each("${column}")),
           '{}'::jsonb)`,
      );
    }
  }
}
