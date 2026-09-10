import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Keeps the request body's JSON Schema alongside the operation that declares it.
 *
 * Without it a project pointed at a fresh contract had no payload to send, so every POST, PUT and
 * PATCH came back 422 until somebody wrote a `bodies` section by hand. The contract had the answer
 * all along; the import was throwing it away.
 *
 * Nullable, and nullable it stays: plenty of operations take no body, and plenty of bodies are not
 * JSON. A null here means "nothing to derive", which is the same behaviour every row had before
 * this column existed — so contracts imported by an older version keep working exactly as they
 * did, and re-importing is what fills them in.
 */
export class RequestSchemas1700000004000 implements MigrationInterface {
  name = "RequestSchemas1700000004000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "spec_operations" ADD COLUMN "requestSchema" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "spec_operations" DROP COLUMN "requestSchema"`);
  }
}
