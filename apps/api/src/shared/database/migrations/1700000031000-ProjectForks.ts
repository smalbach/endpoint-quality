import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las bifurcaciones de proyecto.
 *
 * ## Una tabla aparte, y no una columna `forkedFrom` en `projects`
 *
 * Porque lo que hace falta guardar no es solo el padre: es la **foto común** —lo que los dos
 * proyectos tenían igual la última vez que se sincronizaron— y el **linaje** —qué flujo de aquí es
 * cuál de allí—. Sin la foto, una comparación entre dos proyectos no distingue «el original lo
 * borró» de «la bifurcación lo creó», y cada una pide lo contrario. Dos `jsonb` que se reescriben
 * enteros en cada sincronización no tienen sitio en la fila que leen todas las pantallas.
 *
 * ## Las dos claves ajenas en cascada
 *
 * Los proyectos se borran en blando, así que esto casi nunca se dispara. Cuando sí —una limpieza a
 * mano—, una bifurcación cuyo original ya no existe es un proyecto normal, y una fila huérfana aquí
 * solo serviría para que la pantalla ofreciera fusionar con nada.
 *
 * La foto no lleva secretos: las variables sensibles son su nombre y la autenticación va sin
 * literales. Es `jsonb` en claro, y tiene que poder serlo.
 */
export class ProjectForks1700000031000 implements MigrationInterface {
  name = "ProjectForks1700000031000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "project_forks" (
        "forkProjectId" uuid PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
        "parentProjectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "organizationId" uuid NOT NULL,
        "createdBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "syncedAt" timestamptz NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        "base" jsonb NOT NULL,
        "lineage" jsonb NOT NULL,
        CHECK ("forkProjectId" <> "parentProjectId")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_project_forks_parentProjectId" ON "project_forks" ("parentProjectId")`);
    await queryRunner.query(`CREATE INDEX "IDX_project_forks_organizationId" ON "project_forks" ("organizationId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "project_forks"`);
  }
}
