import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Una corrida sin contrato.
 *
 * `runs.specVersionId` era obligatorio porque toda corrida recorría operaciones del contrato. Ya no:
 * un monitor que vigila un canal, o un flujo hecho solo de fetch, GraphQL, mocks, canales y webhooks,
 * no lee ninguna operación, y pedirle al proyecto un contrato importado para ejecutarlos era un 409
 * sin motivo. La columna pasa a admitir `NULL` —«esta corrida no se midió contra ningún contrato»—, y
 * la clave ajena se queda como estaba: cuando hay versión, sigue sin poder borrarse debajo de la
 * corrida.
 */
export class RunsWithoutContract1700000040000 implements MigrationInterface {
  name = "RunsWithoutContract1700000040000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" ALTER COLUMN "specVersionId" DROP NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Una corrida sin contrato no cabe en el esquema de antes: se va, y sus casos con ella.
    await queryRunner.query(`DELETE FROM "runs" WHERE "specVersionId" IS NULL`);
    await queryRunner.query(`ALTER TABLE "runs" ALTER COLUMN "specVersionId" SET NOT NULL`);
  }
}
