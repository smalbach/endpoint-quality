import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * El proxy de captura en varias instancias: el token se busca en la tabla.
 *
 * Hasta ahora el registro de tokens vivía en la memoria del proceso que abrió la sesión, y el
 * puerto del proxy tenía que caer en esa instancia. Ahora cualquier instancia busca la sesión por
 * `tokenHash` en cada petición (con una caché de un segundo), así que esa búsqueda necesita un
 * índice, y **único**: dos sesiones con el mismo hash serían el mismo token abriendo dos capturas.
 * Un token de 256 bits aleatorios no repite; si repitiera, mejor un error al abrir que una
 * petición grabada en la sesión de otro proyecto.
 */
export class CaptureProxyInstances1700000037000 implements MigrationInterface {
  name = "CaptureProxyInstances1700000037000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_capture_sessions_token_hash" ON "capture_sessions" ("tokenHash")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_capture_sessions_token_hash"`);
  }
}
