import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Cómo entra cada endpoint: los mismos tipos de autenticación que Postman.
 *
 * Antes solo había un `requiresAuth` booleano y tres modos en el botón de enviar —heredar, ninguno,
 * y un `Bearer` escrito a mano—, así que el bloque `auth` de una colección importada se tiraba
 * entero. Una colección real lleva su autenticación arriba y las peticiones la heredan: perder ese
 * bloque no perdía un detalle, dejaba todas las peticiones importadas respondiendo 401.
 *
 * `requiresAuth` **se queda**. Dice otra cosa: si el endpoint *necesita* autenticación, que es lo
 * que leen las pruebas de seguridad y la matriz de roles. La columna nueva dice *cuál*, que es lo
 * que hace falta para enviarlo.
 *
 * Las filas que ya existen quedan en `inherit`, que es lo que hacían: usar la del proyecto. Un
 * defecto `none` habría convertido en silencio cada endpoint guardado en uno que no se autentica.
 */
export class RequestAuth1700000021000 implements MigrationInterface {
  name = "RequestAuth1700000021000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "endpoints" ADD COLUMN "auth" jsonb NOT NULL DEFAULT '{"type":"inherit","params":{}}'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "endpoints" DROP COLUMN "auth"`);
  }
}
