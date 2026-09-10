/**
 * The half the in-memory suite cannot check: the migrations, and the constraints that only
 * exist in SQL.
 *
 * A repository backed by a `Map` will happily store two users with the same email, two
 * organizations with the same slug, and a membership pointing at an organization that was
 * deleted. Postgres will not — but only if the migration actually declared the index and the
 * foreign key. That declaration is what this file checks, against a real database.
 *
 * **It needs a running Postgres and skips loudly without one**, rather than passing quietly.
 * A suite that reports success when it verified nothing is the exact failure this whole product
 * exists to catch, and it would be embarrassing to ship it here.
 *
 *     docker compose -f docker/compose.yml up -d postgres
 *     EQ_TEST_DATABASE_URL=postgres://eq:eq@localhost:5432/endpoint_quality_test pnpm --filter @eq/api test:db
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

import { buildDataSourceOptions } from "@/shared/database/data-source";

const DATABASE_URL = process.env.EQ_TEST_DATABASE_URL;
const REASON = "sin EQ_TEST_DATABASE_URL: levanta Postgres (docker compose -f docker/compose.yml up -d postgres) y reexporta la variable";

let dataSource: DataSource | undefined;

before(async () => {
  if (!DATABASE_URL) return;
  dataSource = new DataSource(buildDataSourceOptions(DATABASE_URL));
  await dataSource.initialize();
  // Applied forwards from empty on every run: a migration that only works against a database
  // that already has the tables is not a migration.
  await dataSource.runMigrations();
});

after(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

const insertUser = (id: string, email: string) =>
  dataSource!.query(`INSERT INTO users (id, email, name, "passwordDigest", status, "createdAt") VALUES ($1, $2, 'x', 'x', 'active', now())`, [id, email]);
const insertOrganization = (id: string, slug: string) =>
  dataSource!.query(`INSERT INTO organizations (id, name, slug, "createdAt") VALUES ($1, 'x', $2, now())`, [id, slug]);

describe("migraciones", { skip: DATABASE_URL ? false : REASON }, () => {
  test("crean todas las tablas del esquema inicial", async () => {
    const rows: { table_name: string }[] = await dataSource!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'migrations'`,
    );
    const tables = rows.map((row) => row.table_name).sort();
    assert.deepEqual(tables, [
      "api_tokens", "invitations", "memberships", "organizations", "projects",
      "refresh_tokens", "spec_operations", "spec_sources", "spec_versions", "users",
    ]);
  });

  test("son reversibles: cada down deshace su up y up lo reconstruye", async () => {
    // A migration nobody has ever reverted is a migration that cannot be reverted, and that is
    // discovered during the incident rather than before it. Both are undone, in order, because
    // the second adds a foreign key into a table the first creates — reverting only the last
    // would leave a constraint pointing at a table about to disappear.
    const exists = async (table: string) =>
      ((await dataSource!.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [table])) as unknown[]).length;

    await dataSource!.undoLastMigration();
    assert.equal(await exists("spec_versions"), 0);
    assert.equal(await exists("users"), 1, "revertir la segunda migración no debe tocar la primera");

    await dataSource!.undoLastMigration();
    assert.equal(await exists("users"), 0);

    await dataSource!.runMigrations();
    assert.equal(await exists("users"), 1);
    assert.equal(await exists("spec_operations"), 1);
  });

  test("correr las migraciones dos veces no hace nada la segunda", async () => {
    assert.deepEqual(await dataSource!.runMigrations(), []);
  });
});

describe("restricciones que solo existen en SQL", { skip: DATABASE_URL ? false : REASON }, () => {
  test("dos cuentas no pueden compartir correo", async () => {
    const email = `dup-${randomUUID()}@example.com`;
    await insertUser(randomUUID(), email);
    await assert.rejects(insertUser(randomUUID(), email), /duplicate key|unique/i);
  });

  test("dos organizaciones no pueden compartir slug", async () => {
    const slug = `slug-${randomUUID().slice(0, 8)}`;
    await insertOrganization(randomUUID(), slug);
    await assert.rejects(insertOrganization(randomUUID(), slug), /duplicate key|unique/i);
  });

  test("una membresía no puede apuntar a una organización inexistente", async () => {
    // Without the foreign key, a delete elsewhere leaves a membership granting a role in
    // something that no longer exists — and the role check would still pass.
    const userId = randomUUID();
    await insertUser(userId, `fk-${userId}@example.com`);
    await assert.rejects(
      dataSource!.query(`INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`, [randomUUID(), userId]),
      /foreign key/i,
    );
  });

  test("la misma persona no puede estar dos veces en una organización", async () => {
    const [userId, organizationId] = [randomUUID(), randomUUID()];
    await insertUser(userId, `pk-${userId}@example.com`);
    await insertOrganization(organizationId, `pk-${organizationId.slice(0, 8)}`);
    const insert = () => dataSource!.query(`INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'viewer', now())`, [organizationId, userId]);
    await insert();
    // Two rows would mean two roles, and which one wins would depend on row order.
    await assert.rejects(insert(), /duplicate key|unique/i);
  });

  test("borrar una organización se lleva sus membresías y tokens", async () => {
    const [userId, organizationId] = [randomUUID(), randomUUID()];
    await insertUser(userId, `cascade-${userId}@example.com`);
    await insertOrganization(organizationId, `cascade-${organizationId.slice(0, 8)}`);
    await dataSource!.query(`INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`, [organizationId, userId]);
    await dataSource!.query(
      `INSERT INTO api_tokens (id, "organizationId", name, "tokenHash", preview, "createdBy", "createdAt") VALUES ($1, $2, 'ci', $3, 'eqt_ab…cd', $4, now())`,
      [randomUUID(), organizationId, randomUUID(), userId],
    );

    await dataSource!.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    // A live API token pointing at a deleted organization is a credential with no owner and no
    // way to revoke it from the UI.
    const tokens: unknown[] = await dataSource!.query(`SELECT 1 FROM api_tokens WHERE "organizationId" = $1`, [organizationId]);
    const memberships: unknown[] = await dataSource!.query(`SELECT 1 FROM memberships WHERE "organizationId" = $1`, [organizationId]);
    assert.equal(tokens.length, 0);
    assert.equal(memberships.length, 0);
  });

  test("dos refresh tokens no pueden compartir hash", async () => {
    const userId = randomUUID();
    await insertUser(userId, `rt-${userId}@example.com`);
    const hash = randomUUID();
    const insert = () =>
      dataSource!.query(
        `INSERT INTO refresh_tokens (id, "userId", "sessionId", "tokenHash", "expiresAt", "createdAt") VALUES ($1, $2, $3, $4, now() + interval '30 days', now())`,
        [randomUUID(), userId, randomUUID(), hash],
      );
    await insert();
    await assert.rejects(insert(), /duplicate key|unique/i);
  });

  test("dos proyectos de una organización no pueden compartir slug, pero sí de organizaciones distintas", async () => {
    // Unique per organization. A global namespace would let one customer discover another exists
    // by the suffix their project silently receives.
    const [userId, orgA, orgB] = [randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `slug-${userId}@example.com`);
    await insertOrganization(orgA, `a-${orgA.slice(0, 8)}`);
    await insertOrganization(orgB, `b-${orgB.slice(0, 8)}`);
    const insertProject = (organizationId: string) =>
      dataSource!.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', 'catalog', $3, now())`, [randomUUID(), organizationId, userId]);

    await insertProject(orgA);
    await assert.rejects(insertProject(orgA), /duplicate key|unique/i);
    await insertProject(orgB);
  });

  test("borrar una versión deja el proyecto en pie sin contrato activo", async () => {
    // SET NULL and not CASCADE: removing a snapshot must not delete the project and everything
    // configured under it.
    const [userId, organizationId, projectId, versionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `ver-${userId}@example.com`);
    await insertOrganization(organizationId, `v-${organizationId.slice(0, 8)}`);
    await dataSource!.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `p-${projectId.slice(0, 8)}`, userId]);
    await dataSource!.query(
      `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 0, '[]'::jsonb, $4, now())`,
      [versionId, projectId, randomUUID().replace(/-/g, ""), userId],
    );
    await dataSource!.query(`UPDATE projects SET "activeSpecVersionId" = $1 WHERE id = $2`, [versionId, projectId]);

    await dataSource!.query(`DELETE FROM spec_versions WHERE id = $1`, [versionId]);
    const [project]: { activeSpecVersionId: string | null }[] = await dataSource!.query(`SELECT "activeSpecVersionId" FROM projects WHERE id = $1`, [projectId]);
    assert.equal(project.activeSpecVersionId, null);
  });

  test("borrar una versión se lleva sus operaciones", async () => {
    const [userId, organizationId, projectId, versionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `ops-${userId}@example.com`);
    await insertOrganization(organizationId, `o-${organizationId.slice(0, 8)}`);
    await dataSource!.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `q-${projectId.slice(0, 8)}`, userId]);
    await dataSource!.query(
      `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 1, '[]'::jsonb, $4, now())`,
      [versionId, projectId, randomUUID().replace(/-/g, ""), userId],
    );
    const insertOperation = () =>
      dataSource!.query(
        `INSERT INTO spec_operations (id, "specVersionId", "operationId", method, path, statuses, parameters, security, position)
         VALUES ($1, $2, 'listThings', 'GET', '/things', '[200]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`,
        [randomUUID(), versionId],
      );
    await insertOperation();
    // Two operations under one id in the same version would share configuration silently.
    await assert.rejects(insertOperation(), /duplicate key|unique/i);

    await dataSource!.query(`DELETE FROM spec_versions WHERE id = $1`, [versionId]);
    const left: unknown[] = await dataSource!.query(`SELECT 1 FROM spec_operations WHERE "specVersionId" = $1`, [versionId]);
    assert.equal(left.length, 0);
  });

  test("los índices que sostienen cada comprobación de autorización existen", async () => {
    // Every request resolves "what is this user's role here", so this lookup is as hot as the
    // primary key.
    const rows: { indexname: string }[] = await dataSource!.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('memberships','refresh_tokens','api_tokens','projects','spec_versions','spec_operations')`);
    const names = rows.map((row) => row.indexname);
    for (const expected of [
      "ix_memberships_user", "ix_refresh_tokens_session", "ux_refresh_tokens_hash", "ux_api_tokens_hash",
      // A re-import looks the document up by hash before parsing it; without this index a
      // scheduled drift check scans every version the project ever had.
      "ux_projects_org_slug", "ux_spec_versions_project_hash", "ix_spec_operations_version",
    ]) {
      assert.ok(names.includes(expected), `falta el índice ${expected}`);
    }
  });
});
