import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los ejemplos guardados de cada endpoint: lo que contestó una vez, con la petición que lo provocó.
 *
 * Sin esto la pregunta «qué devolvía esto la semana pasada» solo se respondía buceando en el
 * historial de una corrida, y una colección de Postman con ejemplos entraba perdiéndolos — el array
 * `response` de cada `item` no se leía en ningún sitio.
 *
 * **Del proyecto, no de la persona.** Al contrario que el tarro de cookies o el token de sesión: un
 * ejemplo es documentación del endpoint, y documentación que solo ve quien la guardó no documenta
 * nada. Es la misma razón por la que el endpoint es del proyecto.
 *
 * `endpointId` con `ON DELETE CASCADE`: un ejemplo sin su endpoint no es nada. El borrado de un
 * endpoint es blando (`deletedAt`), así que en la práctica los ejemplos sobreviven a un borrado
 * reversible —y vuelven con él— y solo desaparecen cuando la fila se va de verdad.
 *
 * El par entero va en dos `jsonb` y no en columnas: la forma de una petición y de una respuesta ya
 * está definida en el dominio, y partirla en quince columnas obligaría a migrar la tabla cada vez
 * que al editor le crece un campo.
 */
export class EndpointExamples1700000023000 implements MigrationInterface {
  name = "EndpointExamples1700000023000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "endpoint_examples" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "endpointId" uuid NOT NULL REFERENCES "endpoints"("id") ON DELETE CASCADE,
        "name" varchar(200) NOT NULL,
        "request" jsonb NOT NULL,
        "response" jsonb NOT NULL,
        "origin" varchar(20) NOT NULL DEFAULT 'manual',
        "orderIndex" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "createdBy" uuid NOT NULL
      )
    `);
    // Lo que se lee siempre: los ejemplos de un endpoint, en su orden, al abrir el editor.
    await queryRunner.query(
      `CREATE INDEX "IDX_endpoint_examples_endpoint" ON "endpoint_examples" ("projectId", "endpointId", "orderIndex")`,
    );
    // Dos ejemplos del mismo endpoint con el mismo nombre serían dos filas indistinguibles en la
    // lista, y el importador ya numera para no chocar: esto es lo que hace que ese numerado importe.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_endpoint_examples_name" ON "endpoint_examples" ("endpointId", "name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "endpoint_examples"`);
  }
}
