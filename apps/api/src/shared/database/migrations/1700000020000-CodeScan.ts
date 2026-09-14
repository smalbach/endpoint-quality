import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Escáner de código: conector al repositorio y el historial de escaneos.
 *
 * Un conector por proyecto (índice único en `projectId`); su token va cifrado (AES-256-GCM), como
 * toda credencial de destino, y se descifra solo en memoria al escanear. Cada escaneo guarda lo que
 * leyó, el diff contra el proyecto y el impacto como jsonb: se leen enteros por escaneo y no se
 * consultan entre escaneos.
 */
export class CodeScan1700000020000 implements MigrationInterface {
  name = "CodeScan1700000020000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "code_connectors" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "provider" varchar(20) NOT NULL DEFAULT 'github',
        "repo" varchar(200) NOT NULL,
        "branch" varchar(200) NOT NULL DEFAULT 'main',
        "basePath" varchar(300) NOT NULL DEFAULT '',
        "prefix" varchar(100) NOT NULL DEFAULT '',
        "tokenCiphertext" text NULL,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_code_connectors_project" ON "code_connectors" ("projectId")`);

    await queryRunner.query(`
      CREATE TABLE "code_scans" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "source" varchar(20) NOT NULL,
        "ref" varchar(120) NOT NULL DEFAULT '',
        "status" varchar(20) NOT NULL,
        "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "diff" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "impact" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "error" text NULL,
        "createdAt" timestamptz NOT NULL,
        "createdBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_code_scans_project" ON "code_scans" ("projectId", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "code_scans"`);
    await queryRunner.query(`DROP TABLE "code_connectors"`);
  }
}
