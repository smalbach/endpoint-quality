import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Colecciones: el árbol de Postman tal cual, y sus corridas.
 *
 * Hasta aquí una colección importada se partía en flujos —un grafo por carpeta, las aristas
 * deducidas del orden— y dejaba de ser una colección: no se podía volver a exportar, ni editar
 * como en el producto del que venía, ni correr de arriba abajo como allí. El documento entero va
 * en una columna `jsonb` porque una colección es un fichero: se lee entera y se escribe entera, y
 * nadie consulta peticiones sueltas entre colecciones.
 *
 * `collection_runs.collectionId` no lleva clave foránea a propósito: una corrida es un hecho sobre
 * un rato y borrar la colección no borra lo que se midió, igual que en las corridas de carga.
 */
export class Collections1700000043000 implements MigrationInterface {
  name = "Collections1700000043000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "collections" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(300) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "document" jsonb NOT NULL DEFAULT '{"auth":{"type":"inherit","params":{}},"variables":[],"preRequestScript":"","postResponseScript":"","items":[]}'::jsonb,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_collections_project" ON "collections" ("projectId", "name")`);

    await queryRunner.query(`
      CREATE TABLE "collection_runs" (
        "id" uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "collectionId" uuid NOT NULL,
        "collectionName" varchar(300) NOT NULL DEFAULT '',
        "environmentId" uuid NULL,
        "environmentName" varchar(200) NULL,
        "status" varchar(20) NOT NULL,
        "iterations" integer NOT NULL DEFAULT 1,
        "delayMs" integer NOT NULL DEFAULT 0,
        "stopOnFailure" boolean NOT NULL DEFAULT false,
        "folderId" varchar(80) NULL,
        "folderName" varchar(300) NULL,
        "totals" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "results" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "startedAt" timestamptz NOT NULL,
        "finishedAt" timestamptz NULL,
        "error" text NULL,
        "startedBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_collection_runs_project" ON "collection_runs" ("projectId", "startedAt")`,
    );
    await queryRunner.query(`CREATE INDEX "ix_collection_runs_collection" ON "collection_runs" ("collectionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "collection_runs"`);
    await queryRunner.query(`DROP TABLE "collections"`);
  }
}
