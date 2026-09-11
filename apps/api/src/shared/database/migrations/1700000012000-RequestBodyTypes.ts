import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * El cuerpo de una petición deja de tener que ser JSON.
 *
 * `body` was `jsonb` holding the payload itself, so the column could say two things: this object,
 * or nothing. That is exactly what the generated matrix has — it derives its payloads from JSON
 * Schema — and it is not what an API asks for. Plenty still take a login as
 * `application/x-www-form-urlencoded`; a webhook is tested by posting the exact XML its provider
 * sends; a form upload endpoint wants `multipart/form-data`. None of those fit in a JSON object,
 * and the editor had nowhere to put them.
 *
 * So the column becomes `{ type, … }`: `none`, `json`, `raw`, `form-data`,
 * `x-www-form-urlencoded`. A tagged shape rather than five nullable columns, because «no payload»,
 * «this JSON» and «these bytes» are different things, and a row carrying both a `text` and a
 * `json` is a state that must not exist.
 *
 * Every stored payload moves across as `json`, and a `NULL` becomes `{"type":"none"}`. Nothing is
 * guessed: a request that held an object was sending it as JSON — that is the only thing the old
 * column could mean — so the conversion is a restatement and not an interpretation.
 */
export class RequestBodyTypes1700000012000 implements MigrationInterface {
  name = "RequestBodyTypes1700000012000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "request_templates"
         SET "body" = CASE
           WHEN "body" IS NULL THEN '{"type":"none"}'::jsonb
           ELSE jsonb_build_object('type', 'json', 'json', "body")
         END`);
    // Not null from here on: «no payload» is a value now — `{"type":"none"}` — and having two ways
    // to say it is how the two end up meaning something slightly different.
    await queryRunner.query(
      `ALTER TABLE "request_templates" ALTER COLUMN "body" SET DEFAULT '{"type":"none"}'::jsonb,
                                       ALTER COLUMN "body" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "request_templates" ALTER COLUMN "body" DROP NOT NULL,
                                       ALTER COLUMN "body" DROP DEFAULT`,
    );
    // A `json` body goes back to the object it was. Everything else goes back to `NULL`, which is
    // the honest reversal and a lossy one: the old shape cannot hold a form or a raw payload, and
    // writing one in as if it were JSON would leave a request that sends an object nobody wrote.
    await queryRunner.query(`
      UPDATE "request_templates"
         SET "body" = CASE WHEN "body" ->> 'type' = 'json' THEN "body" -> 'json' ELSE NULL END`);
  }
}
