import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Capturar tráfico: las sesiones del proxy y lo que grabaron.
 *
 * ## Del token, el hash
 *
 * `tokenHash` es el SHA-256 del token de la sesión, como el de un token de API: un token de 256
 * bits aleatorios no tiene diccionario que atacar, y lo que importa es que un volcado de la base no
 * entregue un proxy abierto. El token en claro se enseña una vez, al abrir la sesión.
 *
 * ## `capture_items` ya llega tapada
 *
 * Las cabeceras y los cuerpos se redactan **antes** de escribir la fila (`captureItemFrom`): la
 * `Authorization` conserva el esquema y pierde el valor, la cookie se tapa, y los campos con nombre
 * de credencial y los JWT sueltos de un cuerpo JSON también. No hay columna en esta tabla que haya
 * visto un secreto.
 *
 * `projectId` va repetido en la petición y no solo en la sesión porque es la columna por la que se
 * filtra **toda** lectura: una consulta que buscara por `sessionId` sola sería la que un día alguien
 * escribe sin el proyecto.
 *
 * ## `(sessionId, seq)`
 *
 * Es el único orden en que se lee —la lista en vivo pide «lo que vino después de la 42»— y es único
 * dentro de una sesión. El `id` aparte existe porque es lo que se elige en pantalla para importar.
 */
export class CaptureSessions1700000032000 implements MigrationInterface {
  name = "CaptureSessions1700000032000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "capture_sessions" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "status" varchar(20) NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "limits" jsonb NOT NULL,
        "itemCount" int NOT NULL DEFAULT 0,
        "startedAt" timestamptz NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "stoppedAt" timestamptz,
        "stopReason" varchar(30),
        "startedBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_capture_sessions_project" ON "capture_sessions" ("projectId", "startedAt" DESC)`,
    );
    // Parcial: al arrancar se buscan las que quedaron abiertas, que son pocas o ninguna.
    await queryRunner.query(
      `CREATE INDEX "IDX_capture_sessions_active" ON "capture_sessions" ("status") WHERE "status" = 'active'`,
    );

    await queryRunner.query(`
      CREATE TABLE "capture_items" (
        "id" uuid PRIMARY KEY,
        "sessionId" uuid NOT NULL REFERENCES "capture_sessions"("id") ON DELETE CASCADE,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "seq" int NOT NULL,
        "at" timestamptz NOT NULL,
        "method" varchar(16) NOT NULL,
        "url" varchar(4000) NOT NULL,
        "status" int,
        "encrypted" boolean NOT NULL DEFAULT false,
        "requestHeaders" jsonb NOT NULL DEFAULT '{}',
        "requestBody" text NOT NULL DEFAULT '',
        "requestBodyTruncated" boolean NOT NULL DEFAULT false,
        "responseHeaders" jsonb NOT NULL DEFAULT '{}',
        "responseBody" text NOT NULL DEFAULT '',
        "responseBodyTruncated" boolean NOT NULL DEFAULT false,
        "responseContentType" varchar(200) NOT NULL DEFAULT '',
        "durationMs" int NOT NULL DEFAULT 0,
        "error" varchar(500)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_capture_items_session_seq" ON "capture_items" ("sessionId", "seq")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "capture_items"`);
    await queryRunner.query(`DROP TABLE "capture_sessions"`);
  }
}
