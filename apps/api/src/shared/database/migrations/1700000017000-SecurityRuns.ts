import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Las corridas de seguridad, como filas propias.
 *
 * Junto a las corridas de contrato pero no dentro de ellas: lo que guardan —hallazgos por
 * severidad, una puntuación, las sondas que los produjeron— tiene otra forma. Las credenciales no
 * están aquí: se leen cifradas del entorno en el momento de ejecutar y no se persisten nunca.
 *
 * `findings` y `probes` van como jsonb: la página de detalle filtra y pagina en memoria, igual que
 * la matriz del contrato, y una tabla por hallazgo sería otra cosa que mantener sincronizada.
 */
export class SecurityRuns1700000017000 implements MigrationInterface {
  name = "SecurityRuns1700000017000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "security_runs" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "environmentId" uuid NOT NULL,
        "label" varchar(120) NOT NULL DEFAULT '',
        "status" varchar(20) NOT NULL,
        "rules" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "options" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "progress" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "score" integer NULL,
        "risk" varchar(20) NULL,
        "summary" jsonb NULL,
        "findings" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "probes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "ai" jsonb NULL,
        "visibility" varchar(10) NOT NULL DEFAULT 'private',
        "shareToken" varchar(36) NULL,
        "triggeredByKind" varchar(20) NOT NULL,
        "triggeredBy" uuid NOT NULL,
        "startedAt" timestamptz NOT NULL,
        "finishedAt" timestamptz NULL,
        "error" text NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_security_runs_project" ON "security_runs" ("projectId", "startedAt")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_security_runs_share" ON "security_runs" ("shareToken") WHERE "shareToken" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "security_runs"`);
  }
}
