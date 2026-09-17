import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los servidores de mocks: una URL pública que contesta con los ejemplos guardados del proyecto.
 *
 * Es lo que hace ejecutables los ejemplos de la ola anterior. Por eso van en este orden y no al
 * revés: un mock sin ejemplos no tiene con qué contestar, y hacerlo primero habría obligado a
 * inventar un almacén de respuestas que después habría que migrar.
 *
 * `publicId` es **único en toda la tabla y no por proyecto**, porque es lo único que llega en la
 * URL: `/mock/<publicId>/...` se resuelve antes de saber de quién es. Aleatorio de 128 bits, con su
 * propio índice único, que además es el que se lee en cada petición servida.
 *
 * De la clave de un mock privado se guarda **el hash**, con el mismo criterio que los tokens de API:
 * un volcado de la base de datos no entrega mocks. La clave se enseña una vez, al crearlo.
 *
 * `ON DELETE CASCADE` sobre `projects`: la URL de un mock de un proyecto que ya no existe tiene que
 * dejar de contestar en el mismo momento, y no cuando alguien se acuerde.
 */
export class MockServers1700000024000 implements MigrationInterface {
  name = "MockServers1700000024000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "mock_servers" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "publicId" varchar(64) NOT NULL,
        "visibility" varchar(20) NOT NULL,
        "apiKeyHash" varchar(64),
        "apiKeyPreview" varchar(20) NOT NULL DEFAULT '',
        "delay" jsonb NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "createdBy" uuid NOT NULL
      )
    `);
    // La lectura de cada petición servida, y a la vez la garantía de que dos mocks no comparten URL.
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_mock_servers_public" ON "mock_servers" ("publicId")`);
    await queryRunner.query(`CREATE INDEX "IDX_mock_servers_project" ON "mock_servers" ("projectId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "mock_servers"`);
  }
}
