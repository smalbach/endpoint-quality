"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InitialSchema1700000000000 = void 0;
/**
 * The first schema: identity, tenancy and credentials.
 *
 * Hand-written rather than generated, and `synchronize` is off everywhere including development.
 * A schema that drifts by inference is a schema no two environments share, and the first time
 * that shows up is on a production deploy.
 */
class InitialSchema1700000000000 {
    name = "InitialSchema1700000000000";
    async up(queryRunner) {
        await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid PRIMARY KEY,
        "email" varchar(320) NOT NULL,
        "name" varchar(200) NOT NULL,
        "passwordDigest" varchar(400) NOT NULL,
        "status" varchar(20) NOT NULL,
        "createdAt" timestamptz NOT NULL
      )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_users_email" ON "users" ("email")`);
        await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid PRIMARY KEY,
        "name" varchar(200) NOT NULL,
        "slug" varchar(80) NOT NULL,
        "createdAt" timestamptz NOT NULL
      )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_organizations_slug" ON "organizations" ("slug")`);
        await queryRunner.query(`
      CREATE TABLE "memberships" (
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role" varchar(20) NOT NULL,
        "createdAt" timestamptz NOT NULL,
        PRIMARY KEY ("organizationId", "userId")
      )`);
        // Every authorization check starts from "what is this user's role here", so the lookup by
        // user is as hot as the composite primary key and gets its own index.
        await queryRunner.query(`CREATE INDEX "ix_memberships_user" ON "memberships" ("userId")`);
        await queryRunner.query(`
      CREATE TABLE "invitations" (
        "id" uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "email" varchar(320) NOT NULL,
        "role" varchar(20) NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "invitedBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "acceptedAt" timestamptz,
        "revokedAt" timestamptz
      )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_invitations_token" ON "invitations" ("tokenHash")`);
        await queryRunner.query(`CREATE INDEX "ix_invitations_org" ON "invitations" ("organizationId")`);
        await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid PRIMARY KEY,
        "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "sessionId" uuid NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "usedAt" timestamptz,
        "revokedAt" timestamptz,
        "replacedByHash" varchar(64)
      )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_refresh_tokens_hash" ON "refresh_tokens" ("tokenHash")`);
        await queryRunner.query(`CREATE INDEX "ix_refresh_tokens_session" ON "refresh_tokens" ("sessionId")`);
        await queryRunner.query(`CREATE INDEX "ix_refresh_tokens_user" ON "refresh_tokens" ("userId")`);
        await queryRunner.query(`
      CREATE TABLE "api_tokens" (
        "id" uuid PRIMARY KEY,
        "organizationId" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "name" varchar(120) NOT NULL,
        "tokenHash" varchar(64) NOT NULL,
        "preview" varchar(20) NOT NULL,
        "createdBy" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "lastUsedAt" timestamptz,
        "revokedAt" timestamptz
      )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_api_tokens_hash" ON "api_tokens" ("tokenHash")`);
        await queryRunner.query(`CREATE INDEX "ix_api_tokens_org" ON "api_tokens" ("organizationId")`);
    }
    async down(queryRunner) {
        await queryRunner.query(`DROP TABLE "api_tokens"`);
        await queryRunner.query(`DROP TABLE "refresh_tokens"`);
        await queryRunner.query(`DROP TABLE "invitations"`);
        await queryRunner.query(`DROP TABLE "memberships"`);
        await queryRunner.query(`DROP TABLE "organizations"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }
}
exports.InitialSchema1700000000000 = InitialSchema1700000000000;
//# sourceMappingURL=1700000000000-InitialSchema.js.map