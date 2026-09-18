import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * El proxy de captura en varias instancias, y la CA para descifrar HTTPS.
 *
 * ## El token se busca en la tabla
 *
 * Hasta ahora el registro de tokens vivía en la memoria del proceso que abrió la sesión, y el
 * puerto del proxy tenía que caer en esa instancia. Ahora cualquier instancia busca la sesión por
 * `tokenHash` en cada petición (con una caché de un segundo), así que esa búsqueda necesita un
 * índice, y **único**: dos sesiones con el mismo hash serían el mismo token abriendo dos capturas.
 * Un token de 256 bits aleatorios no repite; si repitiera, mejor un error al abrir que una
 * petición grabada en la sesión de otro proyecto.
 *
 * ## `capture_sessions.decryptHttps`
 *
 * Si la sesión pidió descifrar HTTPS. Por sesión y no por instalación: aunque el despliegue lo
 * permita (`CAPTURE_MITM=true`), quien abre la captura decide si su dispositivo va a confiar en la
 * CA. Las filas de antes quedan en `false`, que es lo que hacían.
 *
 * ## `capture_authorities`: la CA, con la clave **cifrada**
 *
 * Una fila por instalación (`id = 'default'`). `certificatePem` es público: es lo que se descarga
 * e instala en el dispositivo. `privateKeyCiphertext` es la clave privada cifrada con
 * `SECRETS_KEY` (AES-256-GCM, `v1.…`), **nunca en claro**: una CA así firma certificados para
 * cualquier dominio, y un volcado de la base sin `SECRETS_KEY` no debe bastar para suplantar sitios
 * ante los dispositivos que la instalaron. Si el cifrado no está disponible, la CA no se crea (ver
 * `capture-authority.ts`); no hay columna para guardarla de otra manera.
 */
export class CaptureProxyHardening1700000037000 implements MigrationInterface {
  name = "CaptureProxyHardening1700000037000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_capture_sessions_token_hash" ON "capture_sessions" ("tokenHash")`,
    );
    await queryRunner.query(`ALTER TABLE "capture_sessions" ADD COLUMN "decryptHttps" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`
      CREATE TABLE "capture_authorities" (
        "id" varchar(20) PRIMARY KEY,
        "certificatePem" text NOT NULL,
        "privateKeyCiphertext" text NOT NULL,
        "createdAt" timestamptz NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "capture_authorities"`);
    await queryRunner.query(`ALTER TABLE "capture_sessions" DROP COLUMN "decryptHttps"`);
    await queryRunner.query(`DROP INDEX "IDX_capture_sessions_token_hash"`);
  }
}
