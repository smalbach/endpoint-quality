import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los canales: lo que un proyecto prueba cuando lo que prueba no es una petición.
 *
 * ## Por qué tres tablas nuevas y no una columna `protocol` en `endpoints`
 *
 * Porque todo lector de `endpoints` falla **abierto**: si nadie añade el filtro, la fila sale. Hay
 * siete —el servidor de mocks, la documentación publicada, la matriz de roles, la corrida de
 * seguridad, el bundle exportado, el panel y el escaneo de código— y cada uno mentiría distinto con
 * un socket dentro: el mock serviría `GET /chat`, la documentación publicaría una caja `GET` con
 * query y body, la corrida de seguridad lo atacaría por HTTP. Siete filtros que hay que acordarse
 * de poner y ninguno se pone rojo si falta. Aparte, los siete siguen significando lo que significan
 * **por construcción**.
 *
 * Se llaman `channel_*` y no `socket_*`, y `protocol` nace con la tabla aunque hoy solo valga `ws`:
 * gRPC y MQTT caben aquí sin otra migración.
 *
 * ## `channel_sessions` es una fila, y no un objeto en memoria
 *
 * Porque cerrar la pestaña no puede matar la conversación: el socket vive en el proceso de la API,
 * y quien recarga tiene que poder volver a ella. `ownerInstance` y `heartbeatAt` son lo que falta
 * para que eso sea verdad con más de una instancia: un proceso que se muere deja sesiones `open`
 * que nadie cerraría, y con el latido cualquiera puede ver que ese dueño ya no está.
 *
 * ## `channel_messages` con clave compuesta
 *
 * `(sessionId, seq)`: `seq` ya es único dentro de una sesión, y ese índice es el único camino por el
 * que se lee la tabla —la transcripción de una sesión, en orden—. Un `id` aparte sería un índice más
 * que mantener en la tabla que más crece para no usarlo nunca.
 *
 * `environmentId` es una referencia suelta y sin clave ajena, como `monitor_executions.runId`: el
 * entorno se puede borrar y la transcripción de lo que pasó aquel día se queda.
 */
export class Channels1700000028000 implements MigrationInterface {
  name = "Channels1700000028000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "channel_endpoints" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "protocol" varchar(10) NOT NULL,
        "name" varchar(120) NOT NULL,
        "url" varchar(2000) NOT NULL,
        "subprotocols" jsonb NOT NULL DEFAULT '[]',
        "headers" jsonb NOT NULL DEFAULT '[]',
        "auth" jsonb,
        "limits" jsonb NOT NULL,
        "expectations" jsonb NOT NULL DEFAULT '{}',
        "messages" jsonb NOT NULL DEFAULT '[]',
        "orderIndex" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid,
        "deletedAt" timestamptz
      )
    `);
    // Solo los vivos: los endpoints borran en blando, y ser inconsistente aquí es cómo una consulta
    // se olvida del filtro.
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_endpoints_project" ON "channel_endpoints" ("projectId", "orderIndex") WHERE "deletedAt" IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "channel_sessions" (
        "id" uuid PRIMARY KEY,
        "channelId" uuid NOT NULL REFERENCES "channel_endpoints"("id") ON DELETE CASCADE,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "environmentId" uuid,
        "status" varchar(20) NOT NULL,
        "handshake" jsonb,
        "counters" jsonb NOT NULL,
        "verdict" jsonb,
        "stopReason" varchar(30),
        "closeCode" int,
        "ownerInstance" varchar(64) NOT NULL,
        "heartbeatAt" timestamptz NOT NULL,
        "openedAt" timestamptz NOT NULL,
        "closedAt" timestamptz,
        "startedBy" uuid NOT NULL,
        "prunedAt" timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_sessions_channel" ON "channel_sessions" ("channelId", "openedAt" DESC)`,
    );
    // Parcial: la consulta del segador, que solo mira las que siguen abiertas. Son pocas siempre, y
    // el resto de la tabla —todas las cerradas— no entra nunca en ella.
    await queryRunner.query(
      `CREATE INDEX "IDX_channel_sessions_live" ON "channel_sessions" ("heartbeatAt") WHERE "status" IN ('connecting', 'open')`,
    );

    await queryRunner.query(`
      CREATE TABLE "channel_messages" (
        "sessionId" uuid NOT NULL REFERENCES "channel_sessions"("id") ON DELETE CASCADE,
        "seq" int NOT NULL,
        "direction" varchar(10) NOT NULL,
        "kind" varchar(10) NOT NULL,
        "atMs" int NOT NULL,
        "bytes" int NOT NULL,
        "truncated" boolean NOT NULL DEFAULT false,
        "body" text NOT NULL DEFAULT '',
        PRIMARY KEY ("sessionId", "seq")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "channel_messages"`);
    await queryRunner.query(`DROP TABLE "channel_sessions"`);
    await queryRunner.query(`DROP TABLE "channel_endpoints"`);
  }
}
