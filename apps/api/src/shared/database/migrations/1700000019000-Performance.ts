import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Pruebas de carga: planes y sus corridas.
 *
 * Un plan es lo que se edita y reutiliza —escenarios con peso, perfil de carga, umbrales— y una
 * corrida es una ejecución suya contra un entorno, con los números que dio. El `definition` de la
 * corrida es una copia del plan en ese momento: una corrida es un hecho sobre un minuto y editar el
 * plan después no reescribe lo que midió. Por eso `planId` es nullable y sin clave foránea al plan
 * —borrar el plan no borra su historial—, y ventanas, desglose y umbrales van como jsonb: se leen
 * enteros por corrida y nunca se consultan entre corridas.
 */
export class Performance1700000019000 implements MigrationInterface {
  name = "Performance1700000019000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "performance_plans" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "description" text NULL,
        "definition" jsonb NOT NULL DEFAULT '{"scenarios":[],"profile":{"type":"constant","vus":1,"durationS":30},"thresholds":{}}'::jsonb,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_performance_plans_project" ON "performance_plans" ("projectId", "name")`);

    await queryRunner.query(`
      CREATE TABLE "performance_runs" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "planId" uuid NULL,
        "planName" varchar(120) NOT NULL DEFAULT '',
        "environmentId" uuid NULL,
        "status" varchar(20) NOT NULL,
        "definition" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "progress" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "summary" jsonb NULL,
        "windows" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "endpoints" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "thresholds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "startedAt" timestamptz NOT NULL,
        "finishedAt" timestamptz NULL,
        "error" text NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_performance_runs_project" ON "performance_runs" ("projectId", "startedAt")`,
    );
    await queryRunner.query(`CREATE INDEX "ix_performance_runs_plan" ON "performance_runs" ("planId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "performance_runs"`);
    await queryRunner.query(`DROP TABLE "performance_plans"`);
  }
}
