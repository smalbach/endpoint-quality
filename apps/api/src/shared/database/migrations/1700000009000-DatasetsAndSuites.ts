import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Un flujo por fila de datos, y varios flujos como uno.
 *
 * Two tables for the two things a flow could not say. A dataset turns «create a product» into
 * «create these forty products», which is the difference between a smoke test and a suite. A suite
 * turns nine flows somebody runs in order by hand into one run with one verdict.
 *
 * Both keep their list in `jsonb` rather than in rows of their own, for the same reason the flow
 * keeps its graph in one column: the unit of change is the whole list. A reordered suite is one
 * write, not a set of updates that can half-apply, and a pasted CSV replaces the table rather than
 * reconciling cells nobody refers to individually.
 */
export class DatasetsAndSuites1700000009000 implements MigrationInterface {
  name = "DatasetsAndSuites1700000009000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "workflow_datasets" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "workflowId" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "rows" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_workflow_datasets_workflow" ON "workflow_datasets" ("workflowId")`);
    // Two datasets of a flow cannot share a name: they are chosen from a list by that name, and a
    // list with the same entry twice is a choice nobody can make correctly.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_workflow_datasets_name" ON "workflow_datasets" ("workflowId", "name")`,
    );

    await queryRunner.query(`
      CREATE TABLE "workflow_suites" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "description" text,
        "workflowIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_workflow_suites_name" ON "workflow_suites" ("projectId", "name")`);

    // The run itself needs no column: which dataset it walked and which suite it ran are part of
    // `runs.plan`, where `workflowId` already lives. A run is a record of what happened, and the
    // plan is a snapshot of what was asked for — deleting the dataset afterwards must not rewrite
    // it, which a foreign key would eventually have to.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "workflow_suites"`);
    await queryRunner.query(`DROP TABLE "workflow_datasets"`);
  }
}
