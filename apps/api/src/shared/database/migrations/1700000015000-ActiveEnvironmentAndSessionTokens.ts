import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * El entorno activo, en el servidor, y el token de sesión de cada persona.
 *
 * - **Un entorno activo por proyecto**, como en el analizador, pero en una columna del proyecto y
 *   no en un `isActive` por entorno: así «como mucho uno» lo garantiza el tipo de la columna y no un
 *   índice parcial. Si se borra el entorno activo, la clave queda en nulo y la aplicación promueve
 *   el más antiguo que quede — el analizador dejaba el proyecto sin ninguno.
 * - **Los proyectos que ya tienen entornos no empiezan sin activo**: se elige el más antiguo, que es
 *   el que hasta hoy salía primero en cada selector.
 * - **El token de sesión** es de una persona en un proyecto, y va cifrado. En el analizador vivía en
 *   la memoria del navegador y se perdía al recargar. Los *claims* se guardan en claro porque ya van
 *   en claro dentro del JWT y son lo que se enseña; el token no sale nunca.
 */
export class ActiveEnvironmentAndSessionTokens1700000015000 implements MigrationInterface {
  name = "ActiveEnvironmentAndSessionTokens1700000015000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN "activeEnvironmentId" uuid NULL REFERENCES "environments"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(`
      UPDATE "projects" p SET "activeEnvironmentId" = (
        SELECT e."id" FROM "environments" e WHERE e."projectId" = p."id" ORDER BY e."createdAt" ASC, e."id" ASC LIMIT 1
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "session_tokens" (
        "actorId" uuid NOT NULL,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "tokenCiphertext" text NOT NULL,
        "claims" jsonb NULL,
        "expiresAt" timestamptz NULL,
        "capturedAt" timestamptz NOT NULL,
        "source" varchar(20) NOT NULL,
        PRIMARY KEY ("actorId", "projectId")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "session_tokens"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "activeEnvironmentId"`);
  }
}
