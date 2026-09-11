import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cabeceras propias, y filas que se pueden apagar sin borrarlas.
 *
 * Two things a saved request could not say, and one shape for both:
 *
 * - **its own headers.** A contract declares parameters and payloads; it does not declare the
 *   `X-Tenant` this staging environment routes by, the `Accept-Language` a localized response
 *   needs, or the idempotency key a POST is supposed to carry. Until now the only way to send one
 *   was not to.
 * - **a row that is off.** Parking a parameter meant deleting it, which means retyping it next
 *   week — and the value somebody deleted is exactly the one they had spent an afternoon finding.
 *
 * The off rows go in a **second map beside the first**, never as a flag inside it. It is the shape
 * `environments.disabledVariables` already has, chosen there for the reason that applies here
 * unchanged: `parameters` and `headers` keep meaning what a request sends — everywhere, for every
 * reader — so `scenarioFor` has nothing to filter and the engine never learns the concept at all.
 * A flag inside the map would put the filtering obligation on every future consumer, and the day
 * one of them forgot, a parameter somebody had switched off would quietly be sent again.
 *
 * All four default to `{}`: an existing request has no headers and nothing switched off, which is
 * what it meant before this column existed and what it goes on meaning after.
 */
export class RequestTemplateHeaders1700000011000 implements MigrationInterface {
  name = "RequestTemplateHeaders1700000011000";

  private readonly columns = ["disabledParameters", "headers", "disabledHeaders"];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of this.columns) {
      await queryRunner.query(
        `ALTER TABLE "request_templates" ADD COLUMN "${column}" jsonb NOT NULL DEFAULT '{}'::jsonb`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The switched-off rows go with the columns, which is the honest reversal: the old shape has
    // nowhere to put them, and folding them back into `parameters` would turn «guardado y
    // apagado» into «se envía», silently, on every request that had one.
    for (const column of [...this.columns].reverse()) {
      await queryRunner.query(`ALTER TABLE "request_templates" DROP COLUMN "${column}"`);
    }
  }
}
