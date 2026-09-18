import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las solicitudes de fusión de una bifurcación, y su hilo.
 *
 * ## Dos tablas
 *
 * La solicitud es una fila que cambia de estado; el hilo —comentarios, aprobaciones, la decisión—
 * solo crece. Un `jsonb` de comentarios dentro de la solicitud se reescribiría entero con cada uno,
 * y dos personas comentando a la vez se pisarían.
 *
 * ## Una sola pendiente por bifurcación
 *
 * El índice único parcial sobre `forkProjectId` mientras está `open` o `approved` lo promete la base
 * de datos y no solo el comando: dos clics a la vez en «Crear solicitud» no dejan dos solicitudes
 * que piden lo mismo.
 *
 * ## `diff`
 *
 * La comparación tal como estaba al crearla. Sale de las mismas fotos que la foto común de
 * `project_forks`, que ya no llevan secretos: variables sensibles como su nombre y autenticaciones
 * sin literales. Por eso puede ser `jsonb` en claro.
 *
 * Las claves ajenas van en cascada: una solicitud sin su bifurcación o sin su original ya no puede
 * fusionarse ni leerse con sentido, y los proyectos se borran en blando, así que casi nunca pasa.
 */
export class ForkMergeRequests1700000033000 implements MigrationInterface {
  name = "ForkMergeRequests1700000033000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "fork_merge_requests" (
        "id" uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL,
        "forkProjectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "parentProjectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "title" varchar(200) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "status" varchar(12) NOT NULL
          CHECK ("status" IN ('open', 'approved', 'merged', 'declined', 'closed')),
        "createdBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "diff" jsonb NOT NULL,
        "diffVersion" int NOT NULL,
        "decidedBy" uuid,
        "decidedAt" timestamptz,
        "mergedVersion" int
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_fork_merge_requests_parent" ON "fork_merge_requests" ("organizationId", "parentProjectId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fork_merge_requests_fork" ON "fork_merge_requests" ("organizationId", "forkProjectId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_fork_merge_requests_pending" ON "fork_merge_requests" ("forkProjectId")
       WHERE "status" IN ('open', 'approved')`,
    );
    await queryRunner.query(`
      CREATE TABLE "fork_merge_request_events" (
        "id" uuid PRIMARY KEY,
        "requestId" uuid NOT NULL REFERENCES "fork_merge_requests"("id") ON DELETE CASCADE,
        "organizationId" uuid NOT NULL,
        "authorId" uuid NOT NULL,
        "kind" varchar(12) NOT NULL
          CHECK ("kind" IN ('comment', 'approved', 'declined', 'merged', 'closed')),
        "body" text NOT NULL DEFAULT '',
        "createdAt" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_fork_merge_request_events_request" ON "fork_merge_request_events" ("requestId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "fork_merge_request_events"`);
    await queryRunner.query(`DROP TABLE "fork_merge_requests"`);
  }
}
