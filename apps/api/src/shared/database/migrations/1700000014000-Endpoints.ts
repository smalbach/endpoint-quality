import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los endpoints, como filas propias.
 *
 * - **Borrar es marcar**, `deletedAt`, igual que un proyecto: un endpoint borrado por error se
 *   recupera desde la base, y el índice único solo cuenta los vivos, así que borrar `GET /x` deja
 *   crear otro `GET /x`.
 * - **Los proyectos que ya tienen contrato no empiezan vacíos.** Cada operación de su versión activa
 *   se copia como endpoint de origen `contract`, con sus parámetros de ruta y los de query
 *   apagados. Es lo mismo que hará cada importación de contrato a partir de ahora; hacerlo aquí evita
 *   que la sección Endpoints de un proyecto que funcionaba ayer aparezca en blanco hoy.
 */
export class Endpoints1700000014000 implements MigrationInterface {
  name = "Endpoints1700000014000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "endpoints" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "method" varchar(10) NOT NULL,
        "path" varchar(500) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "pathParameters" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "query" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "headers" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "body" jsonb NOT NULL DEFAULT '{"mode":"none","text":"","contentType":"text/plain","fields":[]}'::jsonb,
        "requiresAuth" boolean NOT NULL DEFAULT false,
        "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "status" varchar(20) NOT NULL DEFAULT 'active',
        "origin" varchar(20) NOT NULL DEFAULT 'manual',
        "operationId" varchar(200) NULL,
        "orderIndex" integer NOT NULL DEFAULT 0,
        "preRequestScript" text NOT NULL DEFAULT '',
        "postResponseScript" text NOT NULL DEFAULT '',
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL,
        "deletedAt" timestamptz NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_endpoints_projectId_status" ON "endpoints" ("projectId", "status")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_endpoints_live_method_path" ON "endpoints" ("projectId", "method", "path") WHERE "deletedAt" IS NULL`,
    );

    await queryRunner.query(`
      INSERT INTO "endpoints" (
        "id", "projectId", "method", "path", "description", "pathParameters", "query", "requiresAuth",
        "tags", "status", "origin", "operationId", "orderIndex", "createdAt", "updatedAt", "updatedBy"
      )
      SELECT DISTINCT ON (p."id", upper(o."method"), o."path")
        gen_random_uuid(),
        p."id",
        upper(o."method"),
        o."path",
        o."summary",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'name', m[1],
            'type', CASE WHEN m[1] ~* 'uuid' THEN 'uuid' ELSE 'string' END,
            'description', '',
            'value', ''
          ))
          FROM regexp_matches(o."path", '\\{([^{}]+)\\}', 'g') AS m
        ), '[]'::jsonb),
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'name', n, 'type', 'string', 'required', false, 'description', '', 'value', '', 'enabled', false
          ))
          FROM jsonb_array_elements_text(o."parameters") AS n
          WHERE position('{' || n || '}' in o."path") = 0
        ), '[]'::jsonb),
        jsonb_array_length(o."security") > 0,
        CASE WHEN o."tag" = '' THEN '[]'::jsonb ELSE jsonb_build_array(o."tag") END,
        'active',
        'contract',
        o."operationId",
        o."position",
        now(),
        now(),
        p."createdBy"
      FROM "projects" p
      JOIN "spec_operations" o ON o."specVersionId" = p."activeSpecVersionId"
      WHERE p."deletedAt" IS NULL AND length(o."path") <= 500
      ORDER BY p."id", upper(o."method"), o."path", o."position"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "endpoints"`);
  }
}
