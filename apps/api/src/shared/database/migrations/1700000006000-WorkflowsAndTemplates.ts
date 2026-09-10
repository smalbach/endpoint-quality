import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Reusable requests, and the flows composed from them.
 *
 * The matrix a contract declares is generated; these are the cases it cannot know — «create this,
 * then read back what it gave you» — and they are rows because a request is referenced by several
 * flows and has to survive being edited in one place.
 */
export class WorkflowsAndTemplates1700000006000 implements MigrationInterface {
  name = "WorkflowsAndTemplates1700000006000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "request_templates" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "operationId" varchar(200) NOT NULL,
        "description" text,
        "expectedStatus" int NOT NULL,
        "parameters" jsonb NOT NULL DEFAULT '{}'::jsonb,
        -- Null is «no payload», '{}' is «an empty one on purpose». The engine sends the second.
        "body" jsonb,
        "auth" varchar(20) NOT NULL DEFAULT 'default',
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL
      )`);
    // The name is how a step is read in a failed case, so two of them in one project would make
    // «Crear pedido» ambiguous exactly where somebody is trying to understand a red result.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_request_templates_project_name" ON "request_templates" ("projectId", "name")`,
    );

    await queryRunner.query(`
      CREATE TABLE "workflows" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "description" text,
        -- { steps: [{ id, requestTemplateId, dependsOn?, captures?, position? }] }
        --
        -- One document and not three tables: the unit of change is the whole graph, and writing
        -- nodes and edges separately can leave an edge pointing at a node that is gone. There is
        -- no foreign key from a step to its template either — it lives inside jsonb — so the two
        -- guards live in the command: an unknown template is a 422, and deleting a referenced one
        -- is a 409.
        "definition" jsonb NOT NULL DEFAULT '{"steps":[]}'::jsonb,
        "createdAt" timestamptz NOT NULL,
        "updatedAt" timestamptz NOT NULL,
        "updatedBy" uuid NOT NULL
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX "ux_workflows_project_name" ON "workflows" ("projectId", "name")`);

    // Flows were briefly a configuration section during development. Nothing released ever wrote
    // one, so this deletes what a developer's own database may hold rather than migrating it.
    await queryRunner.query(`DELETE FROM "project_config" WHERE "section" = 'workflows'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "workflows"`);
    await queryRunner.query(`DROP TABLE "request_templates"`);
  }
}
