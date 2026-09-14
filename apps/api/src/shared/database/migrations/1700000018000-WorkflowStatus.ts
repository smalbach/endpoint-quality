import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Estado del flujo: borrador, listo, archivado.
 *
 * One column that changes one thing — what a suite is offered. A flow used to have no life beyond
 * «exists»; now it can be a draft nobody's checklist should pick up yet, the ready one that counts,
 * or archived out of the way without losing its history or its datasets.
 *
 * Existing flows default to `ready`: they were made to be run, and a migration that quietly turned
 * every saved flow into a draft would empty the pickers that build a suite. New flows start as
 * `draft` — that is the command's job, not the column's, so the default here is the one that keeps
 * the flows already on disk meaning what they meant.
 */
export class WorkflowStatus1700000018000 implements MigrationInterface {
  name = "WorkflowStatus1700000018000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflows" ADD COLUMN "status" varchar(16) NOT NULL DEFAULT 'ready'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflows" DROP COLUMN "status"`);
  }
}
