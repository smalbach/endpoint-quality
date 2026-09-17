import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * La documentación publicada: una URL que enseña los endpoints de un proyecto a quien no tiene
 * cuenta aquí.
 *
 * Va después de los mocks porque es el otro consumidor de los ejemplos, y el que los enseña en vez
 * de servirlos. La tabla es casi la del mock, y eso es una señal de que la decisión es la misma:
 * **una superficie pública de un proyecto, con su identificador opaco y su clave opcional.**
 *
 * `publicId` es **único en toda la tabla y no por proyecto**, porque es lo único que llega en la
 * URL. Aleatorio de 128 bits, con su propio índice único, que es el que se lee en cada lectura.
 *
 * `baseUrl` se guarda aquí y no se saca del entorno activo del proyecto, a propósito: un entorno
 * lleva `{{token}}` y el host interno de preproducción, y resolver variables contra él para pintar
 * una página pública sería publicar sus valores.
 *
 * `includeExamples` empieza en `false`. Publicar la forma de una API es una cosa; publicar sus
 * cuerpos de respuesta —que van sin credenciales pero llenos de nombres y correos de alguien— es
 * otra, y la que arrastra datos no puede ser la que pasa sin mirarse.
 *
 * `ON DELETE CASCADE` sobre `projects`: la URL de la documentación de un proyecto que ya no existe
 * tiene que dejar de contestar en el mismo momento.
 */
export class DocSites1700000025000 implements MigrationInterface {
  name = "DocSites1700000025000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "doc_sites" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "publicId" varchar(64) NOT NULL,
        "visibility" varchar(20) NOT NULL,
        "apiKeyHash" varchar(64),
        "apiKeyPreview" varchar(20) NOT NULL DEFAULT '',
        "baseUrl" varchar(300) NOT NULL DEFAULT '',
        "intro" text NOT NULL DEFAULT '',
        "includeExamples" boolean NOT NULL DEFAULT false,
        "enabled" boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "createdBy" uuid NOT NULL
      )
    `);
    // La lectura de cada página servida, y a la vez la garantía de que dos sitios no comparten URL.
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_doc_sites_public" ON "doc_sites" ("publicId")`);
    await queryRunner.query(`CREATE INDEX "IDX_doc_sites_project" ON "doc_sites" ("projectId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "doc_sites"`);
  }
}
