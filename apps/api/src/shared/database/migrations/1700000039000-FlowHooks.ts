import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los nodos webhook que esperan la llamada de un sistema externo.
 *
 * Una tabla y no una clave en la cola, porque con varias instancias la llamada entra por la que
 * elija el balanceador y la corrida que espera está en la que tomó el trabajo: lo único que las dos
 * comparten siempre es Postgres. Aceptar una llamada es un `UPDATE … WHERE status = 'open'`, así que
 * dos llamadas a la misma URL no pueden ganar las dos, y la instancia que deja de esperar en el mismo
 * instante o encuentra la entrega ya escrita o ha convertido toda llamada posterior en un 404.
 *
 * ## Lo que no está es la decisión de esta tabla
 *
 * **No hay token.** Solo su SHA-256 (`tokenHash`, único: es lo que busca la ruta pública). El token
 * se deriva de `id` con una clave del servidor cada vez que la corrida enseña la URL, así que un
 * volcado de la base no entrega nada que se pueda llamar.
 *
 * **Lo que llegó va tapado**, con las mismas reglas que una captura o un ejemplo, y solo hasta que el
 * flujo lo lee: entonces `delivery` vuelve a `NULL` y lo que queda es la fila del paso de la corrida.
 *
 * `ON DELETE CASCADE` sobre `runs`: una espera de una corrida que ya no existe no espera nada, y la
 * retención que borra corridas se lleva estas filas sin saber que existen.
 */
export class FlowHooks1700000039000 implements MigrationInterface {
  name = "FlowHooks1700000039000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "flow_hooks" (
        "id" uuid PRIMARY KEY,
        "tokenHash" varchar(64) NOT NULL UNIQUE,
        "runId" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
        "caseId" uuid NOT NULL,
        "stepId" varchar(200) NOT NULL,
        "method" varchar(8) NOT NULL,
        "status" varchar(12) NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "delivery" jsonb,
        "createdAt" timestamptz NOT NULL
      )
    `);
    // Las esperas de una corrida: lo que enseña su pantalla mientras espera.
    await queryRunner.query(`CREATE INDEX "IDX_flow_hooks_run" ON "flow_hooks" ("runId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "flow_hooks"`);
  }
}
