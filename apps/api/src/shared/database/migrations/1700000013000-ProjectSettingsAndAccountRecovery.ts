import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lo que un proyecto y una cuenta del analizador tenían y aquí no.
 *
 * - **El proyecto dice a qué API apunta y cómo se entra en ella**: una URL base, sus etiquetas y
 *   la autenticación. La parte que no es secreta —la URL de login, el método, la ruta del token,
 *   el usuario, el nombre de la cabecera— va en `authSettings` y se lee sin clave. Los secretos van
 *   juntos en un solo texto cifrado, y `authSettings.secretFields` dice cuáles hay para poder
 *   enmascararlos sin descifrar nada.
 * - **Borrar un proyecto es marcarlo**, `deletedAt`. Sus corridas son evidencia de lo que pasó un
 *   día, y un borrado físico se las llevaría por la cascada que ya declaran las demás tablas. El
 *   slug queda ocupado a propósito: una URL de CI que apuntaba al borrado no debe empezar a lanzar
 *   corridas contra otro que se llame igual.
 * - **Recuperar la cuenta**: los enlaces de restablecer, en su tabla, y el contador de intentos que
 *   bloquea una cuenta quince minutos tras cinco fallos.
 */
export class ProjectSettingsAndAccountRecovery1700000013000 implements MigrationInterface {
  name = "ProjectSettingsAndAccountRecovery1700000013000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "baseUrl" varchar(2000) NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "tags" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "authType" varchar(20) NOT NULL DEFAULT 'none'`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "authSettings" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "authSecretCiphertext" text NULL`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "deletedAt" timestamptz NULL`);

    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "failedLoginAttempts" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "lockedUntil" timestamptz NULL`);

    await queryRunner.query(`
      CREATE TABLE "password_reset_tokens" (
        "id" uuid PRIMARY KEY,
        "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "tokenHash" varchar(64) NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "usedAt" timestamptz NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_password_reset_tokens_tokenHash" ON "password_reset_tokens" ("tokenHash")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_password_reset_tokens_userId" ON "password_reset_tokens" ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "password_reset_tokens"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "lockedUntil"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "failedLoginAttempts"`);
    for (const column of ["deletedAt", "authSecretCiphertext", "authSettings", "authType", "tags", "baseUrl"]) {
      await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "${column}"`);
    }
  }
}
