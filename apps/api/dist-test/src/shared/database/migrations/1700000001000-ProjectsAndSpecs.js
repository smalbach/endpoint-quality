"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectsAndSpecs1700000001000 = void 0;
/**
 * The contract as data: projects, where their spec comes from, and each imported snapshot.
 *
 * This is the schema that replaces a generated TypeScript file in another repository. Before it,
 * the operation table was compiled into the dashboard's bundle and went stale in silence; here
 * every import is a row with a hash, and "did the contract move" is a query.
 */
class ProjectsAndSpecs1700000001000 {
    name = "ProjectsAndSpecs1700000001000";
    async up(queryRunner) {
        await queryRunner.query(`
      CREATE TABLE "projects" (
        "id" uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "name" varchar(200) NOT NULL,
        "slug" varchar(80) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "createdBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "archivedAt" timestamptz,
        "activeSpecVersionId" uuid
      )`);
        // Unique per organization and not globally: two customers may both have a project called
        // `catalog`, and a global namespace would let one of them discover that the other exists.
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_projects_org_slug" ON "projects" ("organizationId", "slug")`);
        await queryRunner.query(`CREATE INDEX "ix_projects_org" ON "projects" ("organizationId")`);
        await queryRunner.query(`
      CREATE TABLE "spec_sources" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "kind" varchar(20) NOT NULL,
        "location" text NOT NULL DEFAULT '',
        "headersCiphertext" text,
        "createdAt" timestamptz NOT NULL
      )`);
        await queryRunner.query(`CREATE INDEX "ix_spec_sources_project" ON "spec_sources" ("projectId")`);
        await queryRunner.query(`
      CREATE TABLE "spec_versions" (
        "id" uuid PRIMARY KEY,
        "projectId" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "sourceId" uuid REFERENCES "spec_sources"("id") ON DELETE SET NULL,
        "hash" varchar(64) NOT NULL,
        "raw" text NOT NULL,
        "format" varchar(20) NOT NULL,
        "openapiVersion" varchar(20) NOT NULL,
        "title" varchar(200) NOT NULL,
        "contractVersion" varchar(50) NOT NULL,
        "operationCount" int NOT NULL,
        "problems" jsonb NOT NULL,
        "importedBy" uuid NOT NULL,
        "importedAt" timestamptz NOT NULL
      )`);
        // One row per distinct document per project. A re-import of an unchanged contract resolves
        // to the existing version instead of piling up identical snapshots, which is what makes a
        // scheduled drift check cheap enough to run often.
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_spec_versions_project_hash" ON "spec_versions" ("projectId", "hash")`);
        await queryRunner.query(`CREATE INDEX "ix_spec_versions_project" ON "spec_versions" ("projectId", "importedAt" DESC)`);
        await queryRunner.query(`
      CREATE TABLE "spec_operations" (
        "id" uuid PRIMARY KEY,
        "specVersionId" uuid NOT NULL REFERENCES "spec_versions"("id") ON DELETE CASCADE,
        "operationId" varchar(200) NOT NULL,
        "method" varchar(10) NOT NULL,
        "path" text NOT NULL,
        "summary" text NOT NULL DEFAULT '',
        "tag" varchar(120) NOT NULL DEFAULT '',
        "statuses" jsonb NOT NULL,
        "parameters" jsonb NOT NULL,
        "security" jsonb NOT NULL,
        "derivedId" boolean NOT NULL DEFAULT false,
        "position" int NOT NULL
      )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_spec_operations_version_op" ON "spec_operations" ("specVersionId", "operationId")`);
        await queryRunner.query(`CREATE INDEX "ix_spec_operations_version" ON "spec_operations" ("specVersionId", "position")`);
        // Added after `spec_versions` exists, since it points at it. `SET NULL` and not `CASCADE`:
        // deleting a version must leave the project standing with no active contract, not delete
        // the project and everything configured under it.
        await queryRunner.query(`
      ALTER TABLE "projects"
      ADD CONSTRAINT "fk_projects_active_spec"
      FOREIGN KEY ("activeSpecVersionId") REFERENCES "spec_versions"("id") ON DELETE SET NULL`);
    }
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "fk_projects_active_spec"`);
        await queryRunner.query(`DROP TABLE "spec_operations"`);
        await queryRunner.query(`DROP TABLE "spec_versions"`);
        await queryRunner.query(`DROP TABLE "spec_sources"`);
        await queryRunner.query(`DROP TABLE "projects"`);
    }
}
exports.ProjectsAndSpecs1700000001000 = ProjectsAndSpecs1700000001000;
//# sourceMappingURL=1700000001000-ProjectsAndSpecs.js.map