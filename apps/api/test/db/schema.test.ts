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

import { buildDataSourceOptions, MIGRATIONS } from "@/shared/database/data-source";

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
      "api_tokens", "environment_credentials", "environments", "invitations", "memberships",
      "organizations", "project_config", "projects", "refresh_tokens", "run_cases", "run_steps",
      "runs", "spec_operations", "spec_sources", "spec_versions", "users",
    ]);
  });

  test("son reversibles: se deshacen todas y up lo reconstruye entero", async () => {
    // A migration nobody has ever reverted is a migration that cannot be reverted, and that is
    // discovered during the incident rather than before it.
    //
    // Counted from `MIGRATIONS` instead of unrolled by hand. The unrolled version asserted, step
    // by step, which table each `down` removes — and broke the day a fifth migration was added,
    // for a reason that had nothing to do with reversibility. What is actually being claimed is
    // that the whole ladder comes down and goes back up.
    const tables = async () =>
      ((await dataSource!.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'migrations'`)) as { table_name: string }[])
        .map((row) => row.table_name)
        .sort();

    const before = await tables();
    assert.ok(before.length > 0);

    for (let remaining = MIGRATIONS.length; remaining > 0; remaining -= 1) {
      await dataSource!.undoLastMigration();
    }
    // Nothing of ours left standing: a `down` that forgets a table leaves it here, and the next
    // `up` fails on an object that already exists — during the incident.
    assert.deepEqual(await tables(), []);

    await dataSource!.runMigrations();
    assert.deepEqual(await tables(), before, "el esquema reconstruido no es el mismo");
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

  test("un entorno no puede tener dos credenciales del mismo rol", async () => {
    // The generator asks for "the insufficient one"; two rows answering to that would make which
    // token a 403 case sends depend on row order.
    const [userId, organizationId, projectId, environmentId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `cred-${userId}@example.com`);
    await insertOrganization(organizationId, `c-${organizationId.slice(0, 8)}`);
    await dataSource!.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `c-${projectId.slice(0, 8)}`, userId]);
    await dataSource!.query(`INSERT INTO environments (id, "projectId", name, "baseUrl", "createdAt") VALUES ($1, $2, 'e2e', 'https://x.example.com', now())`, [environmentId, projectId]);

    const insertCredential = () =>
      dataSource!.query(
        `INSERT INTO environment_credentials (id, "environmentId", name, role, kind, "secretCiphertext", "createdAt", "updatedAt")
         VALUES ($1, $2, 'admin', 'primary', 'bearer', 'v1.x.y.z', now(), now())`,
        [randomUUID(), environmentId],
      );
    await insertCredential();
    await assert.rejects(insertCredential(), /duplicate key|unique/i);

    // And deleting the environment must take the secrets with it: credentials left behind are a
    // set of live tokens nothing can reach to revoke.
    await dataSource!.query(`DELETE FROM environments WHERE id = $1`, [environmentId]);
    const left: unknown[] = await dataSource!.query(`SELECT 1 FROM environment_credentials WHERE "environmentId" = $1`, [environmentId]);
    assert.equal(left.length, 0);
  });

  test("una sección de configuración es única por proyecto", async () => {
    const [userId, organizationId, projectId] = [randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `cfg-${userId}@example.com`);
    await insertOrganization(organizationId, `g-${organizationId.slice(0, 8)}`);
    await dataSource!.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `g-${projectId.slice(0, 8)}`, userId]);
    const insertSection = () =>
      dataSource!.query(`INSERT INTO project_config ("projectId", section, data, "updatedAt", "updatedBy") VALUES ($1, 'budgets', '{}'::jsonb, now(), $2)`, [projectId, userId]);
    await insertSection();
    // Two rows for one section would make the assembled configuration depend on row order.
    await assert.rejects(insertSection(), /duplicate key|unique/i);
  });

  test("una versión del contrato no se borra mientras una corrida la referencia", async () => {
    // RESTRICT and not CASCADE: a run is only interpretable next to the contract it was measured
    // against, and deleting the snapshot would turn stored evidence into a set of assertions
    // about nothing.
    const [userId, organizationId, projectId, versionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `run-${userId}@example.com`);
    await insertOrganization(organizationId, `r-${organizationId.slice(0, 8)}`);
    await dataSource!.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `r-${projectId.slice(0, 8)}`, userId]);
    await dataSource!.query(
      `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 0, '[]'::jsonb, $4, now())`,
      [versionId, projectId, randomUUID().replace(/-/g, ""), userId],
    );
    const runId = randomUUID();
    await dataSource!.query(
      `INSERT INTO runs (id, "projectId", "specVersionId", status, plan, totals, "triggeredByKind", "triggeredBy", "startedAt")
       VALUES ($1, $2, $3, 'passed', '{}'::jsonb, '{}'::jsonb, 'user', $4, now())`,
      [runId, projectId, versionId, userId],
    );

    await assert.rejects(dataSource!.query(`DELETE FROM spec_versions WHERE id = $1`, [versionId]), /foreign key|violates/i);

    // Deleting the project, on the other hand, takes its runs, cases and steps with it.
    const caseId = randomUUID();
    await dataSource!.query(`INSERT INTO run_cases (id, "runId", "operationId", "scenarioId", method, path, status, position) VALUES ($1, $2, 'o', 's', 'GET', '/x', 'passed', 0)`, [caseId, runId]);
    await dataSource!.query(
      `INSERT INTO run_steps (id, "runCaseId", index, purpose, label, request, expected, assertions, ok, "durationMs")
       VALUES ($1, $2, 0, 'act', 'l', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, true, 5)`,
      [randomUUID(), caseId],
    );
    await dataSource!.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    const steps: unknown[] = await dataSource!.query(`SELECT 1 FROM run_steps WHERE "runCaseId" = $1`, [caseId]);
    assert.equal(steps.length, 0);
  });

  test("dos casos de una corrida no pueden ocupar la misma posición", async () => {
    // The position is the execution order, and two rows claiming one slot would make the replay
    // of a run depend on which came back first.
    const [userId, organizationId, projectId, versionId, runId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `pos-${userId}@example.com`);
    await insertOrganization(organizationId, `p-${organizationId.slice(0, 8)}`);
    await dataSource!.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `s-${projectId.slice(0, 8)}`, userId]);
    await dataSource!.query(
      `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 0, '[]'::jsonb, $4, now())`,
      [versionId, projectId, randomUUID().replace(/-/g, ""), userId],
    );
    await dataSource!.query(
      `INSERT INTO runs (id, "projectId", "specVersionId", status, plan, totals, "triggeredByKind", "triggeredBy", "startedAt")
       VALUES ($1, $2, $3, 'running', '{}'::jsonb, '{}'::jsonb, 'user', $4, now())`,
      [runId, projectId, versionId, userId],
    );
    const insertCase = () =>
      dataSource!.query(`INSERT INTO run_cases (id, "runId", "operationId", "scenarioId", method, path, status, position) VALUES ($1, $2, 'o', 's', 'GET', '/x', 'queued', 0)`, [randomUUID(), runId]);
    await insertCase();
    await assert.rejects(insertCase(), /duplicate key|unique/i);
  });

  test("los índices que sostienen cada comprobación de autorización existen", async () => {
    // Every request resolves "what is this user's role here", so this lookup is as hot as the
    // primary key.
    const rows: { indexname: string }[] = await dataSource!.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('memberships','refresh_tokens','api_tokens','projects','spec_versions','spec_operations','environments','environment_credentials','runs','run_cases')`);
    const names = rows.map((row) => row.indexname);
    for (const expected of [
      "ix_memberships_user", "ix_refresh_tokens_session", "ux_refresh_tokens_hash", "ux_api_tokens_hash",
      // A re-import looks the document up by hash before parsing it; without this index a
      // scheduled drift check scans every version the project ever had.
      "ux_projects_org_slug", "ux_spec_versions_project_hash", "ix_spec_operations_version",
      "ux_environments_project_name", "ux_credentials_environment_role",
      // The history view is "this project's runs, newest first", and it is the only query
      // anybody makes against that table often.
      "ix_runs_project_started", "ux_run_cases_run_position",
    ]) {
      assert.ok(names.includes(expected), `falta el índice ${expected}`);
    }
  });
});
