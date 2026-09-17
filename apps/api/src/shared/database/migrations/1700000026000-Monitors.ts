import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Los monitores: corridas guardadas que se lanzan solas, y el historial de cada una.
 *
 * ## `nextRunAt` es la columna que hace todo
 *
 * Es por la que se busca lo vencido, es la que se adelanta al reclamarlo, y es la que **apaga** un
 * monitor: nula significa que nadie lo va a tomar. Su índice es parcial —solo las filas encendidas
 * con turno— porque es exactamente la consulta del turno, que corre cada minuto en cada instancia,
 * y un índice sobre la tabla entera haría trabajo por las filas que nunca salen en ella.
 *
 * ## `monitor_executions` es una tabla y no una vista sobre `runs`
 *
 * Porque la retención **borra corridas viejas** (`RETENTION_RUNS_DAYS`), y un historial leído de
 * `runs` se iría vaciando por detrás sin que nadie lo pidiera. La fila de la vuelta es pequeña
 * —estado, cuándo, cuántos casos— y sobrevive al barrido, que es lo que un historial tiene que
 * hacer. `runId` es una referencia suelta y **sin clave ajena**, por eso mismo: la corrida se puede
 * ir y la vuelta se queda.
 *
 * El índice de `runId` no es de lujo: cada corrida que termina en la instalación entera pregunta
 * por esta tabla para saber si era de un monitor, y la gran mayoría no lo son.
 *
 * `ON DELETE CASCADE` sobre `projects` en las dos tablas, y de `monitor_executions` sobre
 * `monitors`: un monitor borrado no debe seguir teniendo historial, y un proyecto borrado no debe
 * seguir lanzando corridas.
 */
export class Monitors1700000026000 implements MigrationInterface {
  name = "Monitors1700000026000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "monitors" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "schedule" jsonb NOT NULL,
        "plan" jsonb NOT NULL,
        "alert" jsonb,
        "nextRunAt" timestamptz,
        "lastRunAt" timestamptz,
        "lastOutcome" varchar(20),
        "consecutiveFailures" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "createdBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_monitors_project" ON "monitors" ("projectId")`);
    // Parcial: es literalmente la consulta del turno, y nada más entra nunca en ella.
    await queryRunner.query(
      `CREATE INDEX "IDX_monitors_due" ON "monitors" ("nextRunAt") WHERE "enabled" AND "nextRunAt" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "monitor_executions" (
        "id" uuid PRIMARY KEY,
        "monitorId" uuid NOT NULL REFERENCES "monitors"("id") ON DELETE CASCADE,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "runId" uuid,
        "outcome" varchar(20) NOT NULL,
        "startedAt" timestamptz NOT NULL,
        "finishedAt" timestamptz,
        "totals" jsonb,
        "note" text NOT NULL DEFAULT ''
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_monitor_executions_monitor" ON "monitor_executions" ("monitorId", "startedAt" DESC)`,
    );
    // Cada corrida que termina pregunta por aquí. Sin este índice, cada final de corrida sería un
    // recorrido de la tabla entera.
    await queryRunner.query(`CREATE INDEX "IDX_monitor_executions_run" ON "monitor_executions" ("runId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "monitor_executions"`);
    await queryRunner.query(`DROP TABLE "monitors"`);
  }
}
