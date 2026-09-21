import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las dos puertas que faltaban en casi todo: **archivar** y **borrar sin perder**.
 *
 * Hasta aquí solo el proyecto y el endpoint sabían salir de la lista sin desaparecer. Todo lo
 * demás —un monitor, un mock, una documentación publicada, un plan de carga, un entorno, un rol,
 * un conjunto de datos, una suite, un flujo, un canal— se borraba de verdad: un clic de más y la
 * fila ya no estaba, con su historial detrás. El arrepentimiento es la razón de esta migración.
 *
 * ## Dos columnas y no una de estado
 *
 * `archivedAt` y `deletedAt` en vez de un `status` con tres valores porque son **dos hechos
 * distintos que pueden convivir**: algo archivado hace un mes y borrado ayer sigue teniendo las
 * dos fechas, y al restaurarlo vuelve a estar archivado, que es donde estaba. Un `status` habría
 * perdido la primera fecha al escribir la segunda, y «restaurar» tendría que adivinar a qué.
 *
 * Las fechas, además, contestan «¿desde cuándo?» sin una tabla de auditoría, que es la pregunta
 * que se hace quien abre el filtro de eliminados.
 *
 * ## Dónde no van
 *
 * - `workflows` y `endpoints` ya dicen «archivado» con su `status`, y ese valor se exporta, se
 *   importa y se compara entre forks. Una segunda forma de decir lo mismo serían dos fuentes de
 *   verdad para la misma pregunta, así que ahí solo se añade `deletedAt`.
 * - `channel_endpoints` ya tenía `deletedAt` desde `1700000028000`; solo le falta archivar.
 * - Las tablas de evidencia —corridas, ejecuciones, llamadas a un mock, mensajes de un canal— no
 *   llevan ninguna: una corrida no se archiva, se retiene o se purga, y eso ya lo decide la
 *   retención.
 *
 * ## Los índices
 *
 * Cada lista lee lo vivo casi siempre, así que el índice útil es **parcial**: las filas con
 * `deletedAt IS NULL`, que es lo que pide la pantalla por defecto. Los eliminados se miran de
 * tarde en tarde y caben en un escaneo del proyecto.
 */
const BOTH = [
  "environments",
  "workflow_datasets",
  "workflow_suites",
  "mock_servers",
  "doc_sites",
  "monitors",
  "project_roles",
  "performance_plans",
];

/** Ya dicen «archivado» de otra manera: solo les falta el borrado reversible. */
const ONLY_DELETED = ["workflows"];

/** Ya nació con `deletedAt`: solo le falta archivar. */
const ONLY_ARCHIVED = ["channel_endpoints"];

/**
 * Los índices únicos de nombre que hay que volver a crear **parciales**.
 *
 * Sin esto, el borrado blando reservaría nombres para siempre: un entorno «staging» eliminado
 * seguiría ocupando «staging» en el índice, y crear otro fallaría con un error de Postgres que
 * ninguna pantalla sabe explicar. Es la misma forma que ya tenía el índice de endpoints, y por la
 * misma razón: lo que no está vivo no compite por el nombre.
 *
 * Restaurar puede entonces chocar con un nombre reutilizado, y eso es un 409 que cada comando
 * comprueba antes de guardar: un conflicto que se ve al restaurar es mejor que un nombre bloqueado
 * por algo que nadie recuerda haber borrado.
 */
const UNIQUE_NAMES: { index: string; table: string; columns: string }[] = [
  { index: "ux_environments_project_name", table: "environments", columns: `"projectId", "name"` },
  { index: "ux_workflows_project_name", table: "workflows", columns: `"projectId", "name"` },
  { index: "UQ_workflow_datasets_name", table: "workflow_datasets", columns: `"workflowId", "name"` },
  { index: "UQ_workflow_suites_name", table: "workflow_suites", columns: `"projectId", "name"` },
  { index: "ux_project_roles_name", table: "project_roles", columns: `"projectId", "name"` },
];

export class ArchiveAndSoftDelete1700000042000 implements MigrationInterface {
  name = "ArchiveAndSoftDelete1700000042000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...BOTH, ...ONLY_ARCHIVED]) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "archivedAt" timestamptz NULL`);
    }
    for (const table of [...BOTH, ...ONLY_DELETED]) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "deletedAt" timestamptz NULL`);
      await queryRunner.query(`CREATE INDEX "IDX_${table}_live" ON "${table}" ("projectId") WHERE "deletedAt" IS NULL`);
    }

    for (const { index, table, columns } of UNIQUE_NAMES) {
      await queryRunner.query(`DROP INDEX "${index}"`);
      await queryRunner.query(`CREATE UNIQUE INDEX "${index}" ON "${table}" (${columns}) WHERE "deletedAt" IS NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // El índice vuelve a ser total antes de que la columna que lo hacía parcial desaparezca. Al
    // revés, Postgres se niega: el índice nombra una columna que ya no existiría.
    for (const { index, table, columns } of UNIQUE_NAMES) {
      await queryRunner.query(`DROP INDEX "${index}"`);
      await queryRunner.query(`CREATE UNIQUE INDEX "${index}" ON "${table}" (${columns})`);
    }
    for (const table of [...BOTH, ...ONLY_DELETED]) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_live"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "deletedAt"`);
    }
    for (const table of [...BOTH, ...ONLY_ARCHIVED]) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "archivedAt"`);
    }
  }
}
