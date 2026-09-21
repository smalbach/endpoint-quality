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
import {
  CaptureAuthorityEntity,
  CaptureItemEntity,
  CaptureSessionEntity,
  RunCaseEntity,
  RunEntity,
  RunStepEntity,
} from "@/shared/database/entities";
import { TypeOrmRunRepository } from "@/modules/runs/infrastructure/persistence/typeorm-run.repository";
import { TypeOrmCaptureRepository } from "@/modules/captures/infrastructure/persistence/typeorm-capture.repository";
import { TypeOrmCaptureAuthorityRepository } from "@/modules/captures/infrastructure/persistence/typeorm-capture-authority.repository";
import { TypeOrmExecutionTurnStore } from "@/shared/turns/typeorm-execution-turns";

const DATABASE_URL = process.env.EQ_TEST_DATABASE_URL;
const REASON =
  "sin EQ_TEST_DATABASE_URL: levanta Postgres (docker compose -f docker/compose.yml up -d postgres) y reexporta la variable";

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
  dataSource!.query(
    `INSERT INTO users (id, email, name, "passwordDigest", status, "createdAt") VALUES ($1, $2, 'x', 'x', 'active', now())`,
    [id, email],
  );
/** Reverts migrations, newest first, until `name` itself has been reverted. */
async function undoUntil(name: string): Promise<void> {
  for (;;) {
    const [last]: { name: string }[] = await dataSource!.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`);
    await dataSource!.undoLastMigration();
    if (!last || last.name === name) return;
  }
}

const insertOrganization = (id: string, slug: string) =>
  dataSource!.query(`INSERT INTO organizations (id, name, slug, "createdAt") VALUES ($1, 'x', $2, now())`, [id, slug]);

describe("migraciones", { skip: DATABASE_URL ? false : REASON }, () => {
  test("crean todas las tablas del esquema inicial", async () => {
    const rows: { table_name: string }[] = await dataSource!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'migrations'`,
    );
    const tables = rows.map((row) => row.table_name).sort();
    assert.deepEqual(tables, [
      "api_tokens",
      "capture_authorities",
      "capture_items",
      "capture_sessions",
      "channel_endpoints",
      "channel_messages",
      "channel_proto_files",
      "channel_sessions",
      "code_connectors",
      "code_scans",
      "collection_runs",
      "collections",
      "doc_sites",
      "endpoint_examples",
      "endpoints",
      "environment_credentials",
      "environments",
      "execution_turns",
      "flow_hooks",
      "fork_merge_request_events",
      "fork_merge_requests",
      "invitations",
      "memberships",
      "mock_calls",
      "mock_servers",
      "monitor_executions",
      "monitors",
      "organizations",
      "password_reset_tokens",
      "performance_plans",
      "performance_runs",
      "project_config",
      "project_forks",
      "project_roles",
      "projects",
      "refresh_tokens",
      "request_cookies",
      "request_templates",
      "role_endpoint_permissions",
      "role_rules",
      "run_cases",
      "run_steps",
      "runs",
      "security_runs",
      "session_tokens",
      "spec_operations",
      "spec_sources",
      "spec_versions",
      "users",
      "workflow_datasets",
      "workflow_suites",
      "workflows",
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
      (
        (await dataSource!.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'migrations'`,
        )) as { table_name: string }[]
      )
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
      dataSource!.query(
        `INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`,
        [randomUUID(), userId],
      ),
      /foreign key/i,
    );
  });

  test("la misma persona no puede estar dos veces en una organización", async () => {
    const [userId, organizationId] = [randomUUID(), randomUUID()];
    await insertUser(userId, `pk-${userId}@example.com`);
    await insertOrganization(organizationId, `pk-${organizationId.slice(0, 8)}`);
    const insert = () =>
      dataSource!.query(
        `INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'viewer', now())`,
        [organizationId, userId],
      );
    await insert();
    // Two rows would mean two roles, and which one wins would depend on row order.
    await assert.rejects(insert(), /duplicate key|unique/i);
  });

  test("borrar una organización se lleva sus membresías y tokens", async () => {
    const [userId, organizationId] = [randomUUID(), randomUUID()];
    await insertUser(userId, `cascade-${userId}@example.com`);
    await insertOrganization(organizationId, `cascade-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`,
      [organizationId, userId],
    );
    await dataSource!.query(
      `INSERT INTO api_tokens (id, "organizationId", name, "tokenHash", preview, "createdBy", "createdAt") VALUES ($1, $2, 'ci', $3, 'eqt_ab…cd', $4, now())`,
      [randomUUID(), organizationId, randomUUID(), userId],
    );

    await dataSource!.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    // A live API token pointing at a deleted organization is a credential with no owner and no
    // way to revoke it from the UI.
    const tokens: unknown[] = await dataSource!.query(`SELECT 1 FROM api_tokens WHERE "organizationId" = $1`, [
      organizationId,
    ]);
    const memberships: unknown[] = await dataSource!.query(`SELECT 1 FROM memberships WHERE "organizationId" = $1`, [
      organizationId,
    ]);
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
      dataSource!.query(
        `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', 'catalog', $3, now())`,
        [randomUUID(), organizationId, userId],
      );

    await insertProject(orgA);
    await assert.rejects(insertProject(orgA), /duplicate key|unique/i);
    await insertProject(orgB);
  });

  test("dos pruebas de un proyecto no pueden llamarse igual, y borrarlo se las lleva", async () => {
    const [userId, organizationId, projectId] = [randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `wf-${userId}@example.com`);
    await insertOrganization(organizationId, `w-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `w-${projectId.slice(0, 8)}`, userId],
    );
    const insertTemplate = () =>
      dataSource!.query(
        `INSERT INTO request_templates (id, "projectId", name, "operationId", "expectedStatus", "createdAt", "updatedAt", "updatedBy")
         VALUES ($1, $2, 'Crear', 'createThing', 201, now(), now(), $3)`,
        [randomUUID(), projectId, userId],
      );
    await insertTemplate();
    // The name is how a step reads in a failed case; two of them would make it ambiguous exactly
    // where somebody is trying to understand a red result.
    await assert.rejects(insertTemplate(), /duplicate key|unique/i);

    await dataSource!.query(
      `INSERT INTO workflows (id, "projectId", name, definition, "createdAt", "updatedAt", "updatedBy")
       VALUES ($1, $2, 'Crear y consultar', '{"steps":[]}'::jsonb, now(), now(), $3)`,
      [randomUUID(), projectId, userId],
    );

    await dataSource!.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    const templates: unknown[] = await dataSource!.query(`SELECT 1 FROM request_templates WHERE "projectId" = $1`, [
      projectId,
    ]);
    const flows: unknown[] = await dataSource!.query(`SELECT 1 FROM workflows WHERE "projectId" = $1`, [projectId]);
    assert.equal(templates.length, 0);
    assert.equal(flows.length, 0);
  });

  test("borrar una versión deja el proyecto en pie sin contrato activo", async () => {
    // SET NULL and not CASCADE: removing a snapshot must not delete the project and everything
    // configured under it.
    const [userId, organizationId, projectId, versionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `ver-${userId}@example.com`);
    await insertOrganization(organizationId, `v-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `p-${projectId.slice(0, 8)}`, userId],
    );
    await dataSource!.query(
      `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 0, '[]'::jsonb, $4, now())`,
      [versionId, projectId, randomUUID().replace(/-/g, ""), userId],
    );
    await dataSource!.query(`UPDATE projects SET "activeSpecVersionId" = $1 WHERE id = $2`, [versionId, projectId]);

    await dataSource!.query(`DELETE FROM spec_versions WHERE id = $1`, [versionId]);
    const [project]: { activeSpecVersionId: string | null }[] = await dataSource!.query(
      `SELECT "activeSpecVersionId" FROM projects WHERE id = $1`,
      [projectId],
    );
    assert.equal(project.activeSpecVersionId, null);
  });

  test("borrar una versión se lleva sus operaciones", async () => {
    const [userId, organizationId, projectId, versionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `ops-${userId}@example.com`);
    await insertOrganization(organizationId, `o-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `q-${projectId.slice(0, 8)}`, userId],
    );
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
    const left: unknown[] = await dataSource!.query(`SELECT 1 FROM spec_operations WHERE "specVersionId" = $1`, [
      versionId,
    ]);
    assert.equal(left.length, 0);
  });

  test("un entorno no puede tener dos credenciales del mismo rol", async () => {
    // The generator asks for "the insufficient one"; two rows answering to that would make which
    // token a 403 case sends depend on row order.
    const [userId, organizationId, projectId, environmentId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `cred-${userId}@example.com`);
    await insertOrganization(organizationId, `c-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `c-${projectId.slice(0, 8)}`, userId],
    );
    await dataSource!.query(
      `INSERT INTO environments (id, "projectId", name, "baseUrl", "createdAt") VALUES ($1, $2, 'e2e', 'https://x.example.com', now())`,
      [environmentId, projectId],
    );

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
    const left: unknown[] = await dataSource!.query(
      `SELECT 1 FROM environment_credentials WHERE "environmentId" = $1`,
      [environmentId],
    );
    assert.equal(left.length, 0);
  });

  test("una sección de configuración es única por proyecto", async () => {
    const [userId, organizationId, projectId] = [randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `cfg-${userId}@example.com`);
    await insertOrganization(organizationId, `g-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `g-${projectId.slice(0, 8)}`, userId],
    );
    const insertSection = () =>
      dataSource!.query(
        `INSERT INTO project_config ("projectId", section, data, "updatedAt", "updatedBy") VALUES ($1, 'budgets', '{}'::jsonb, now(), $2)`,
        [projectId, userId],
      );
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
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `r-${projectId.slice(0, 8)}`, userId],
    );
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

    await assert.rejects(
      dataSource!.query(`DELETE FROM spec_versions WHERE id = $1`, [versionId]),
      /foreign key|violates/i,
    );

    // Deleting the project, on the other hand, takes its runs, cases and steps with it.
    const caseId = randomUUID();
    await dataSource!.query(
      `INSERT INTO run_cases (id, "runId", "operationId", "scenarioId", method, path, status, position) VALUES ($1, $2, 'o', 's', 'GET', '/x', 'passed', 0)`,
      [caseId, runId],
    );
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
    const [userId, organizationId, projectId, versionId, runId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await insertUser(userId, `pos-${userId}@example.com`);
    await insertOrganization(organizationId, `p-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `s-${projectId.slice(0, 8)}`, userId],
    );
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
      dataSource!.query(
        `INSERT INTO run_cases (id, "runId", "operationId", "scenarioId", method, path, status, position) VALUES ($1, $2, 'o', 's', 'GET', '/x', 'queued', 0)`,
        [randomUUID(), runId],
      );
    await insertCase();
    await assert.rejects(insertCase(), /duplicate key|unique/i);
  });

  test("los índices que sostienen cada comprobación de autorización existen", async () => {
    // Every request resolves "what is this user's role here", so this lookup is as hot as the
    // primary key.
    const rows: { indexname: string }[] = await dataSource!.query(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('memberships','refresh_tokens','api_tokens','projects','spec_versions','spec_operations','environments','environment_credentials','runs','run_cases')`,
    );
    const names = rows.map((row) => row.indexname);
    for (const expected of [
      "ix_memberships_user",
      "ix_refresh_tokens_session",
      "ux_refresh_tokens_hash",
      "ux_api_tokens_hash",
      // A re-import looks the document up by hash before parsing it; without this index a
      // scheduled drift check scans every version the project ever had.
      "ux_projects_org_slug",
      "ux_spec_versions_project_hash",
      "ix_spec_operations_version",
      "ux_environments_project_name",
      "ux_credentials_environment_role",
      // The history view is "this project's runs, newest first", and it is the only query
      // anybody makes against that table often.
      "ix_runs_project_started",
      "ux_run_cases_run_position",
      // Every retention sweep filters runs by when they finished. Without this it is a
      // sequential scan of every run ever executed — of the table the sweep exists to bound.
      "idx_runs_finished_at",
    ]) {
      assert.ok(names.includes(expected), `falta el índice ${expected}`);
    }
  });
});

/**
 * The retention sweep, against real SQL.
 *
 * The in-memory adapter is a fake and cannot check any of this: whether the subquery reaches the
 * right steps, whether `prunedAt IS NULL` really makes a second pass a no-op, whether deleting a
 * run takes its cases and steps with it. Those are the three ways this could quietly destroy data
 * or quietly destroy nothing, and all three live in Postgres.
 */
describe("retención en SQL", { skip: DATABASE_URL ? false : REASON }, () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  /** A run with one case and two steps, finished whenever the caller says — or still going. */
  async function seedRun(finishedAt: Date | null): Promise<{ runId: string; caseId: string }> {
    const [userId, organizationId, projectId, versionId, runId, caseId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await insertUser(userId, `ret-${userId}@example.com`);
    await insertOrganization(organizationId, `t-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `t-${projectId.slice(0, 8)}`, userId],
    );
    await dataSource!.query(
      `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 0, '[]'::jsonb, $4, now())`,
      [versionId, projectId, randomUUID().replace(/-/g, ""), userId],
    );
    await dataSource!.query(
      `INSERT INTO runs (id, "projectId", "specVersionId", status, plan, totals, "triggeredByKind", "triggeredBy", "startedAt", "finishedAt")
       VALUES ($1, $2, $3, 'passed', '{}'::jsonb, '{}'::jsonb, 'user', $4, now(), $5)`,
      [runId, projectId, versionId, userId, finishedAt],
    );
    await dataSource!.query(
      `INSERT INTO run_cases (id, "runId", "operationId", "scenarioId", method, path, status, position) VALUES ($1, $2, 'o', 's', 'GET', '/x', 'passed', 0)`,
      [caseId, runId],
    );
    for (const index of [0, 1]) {
      await dataSource!.query(
        `INSERT INTO run_steps (id, "runCaseId", index, purpose, label, request, expected, actual, assertions, ok, "durationMs")
         VALUES ($1, $2, $3, 'act', 'l', '{"body":"grande"}'::jsonb, '{"status":200}'::jsonb, '{"body":"grande"}'::jsonb, '[{"label":"Estado 200","pass":true}]'::jsonb, true, 5)`,
        [randomUUID(), caseId, index],
      );
    }
    return { runId, caseId };
  }

  const steps = (caseId: string) =>
    dataSource!.query(
      `SELECT request, expected, actual, assertions, ok, "prunedAt" FROM run_steps WHERE "runCaseId" = $1 ORDER BY index`,
      [caseId],
    ) as Promise<
      {
        request: unknown;
        expected: unknown;
        actual: unknown;
        assertions: unknown[];
        ok: boolean;
        prunedAt: Date | null;
      }[]
    >;

  /**
   * The repository itself, not a copy of its SQL.
   *
   * A test that re-types the UPDATE it is checking passes while the repository is wrong, which is
   * the one thing this file exists not to do.
   */
  const repository = () =>
    new TypeOrmRunRepository(
      dataSource!.getRepository(RunEntity),
      dataSource!.getRepository(RunCaseEntity),
      dataSource!.getRepository(RunStepEntity),
    );

  test("vacía los cuerpos de una corrida vieja y deja el veredicto", async () => {
    const { caseId } = await seedRun(daysAgo(40));
    await repository().pruneStepBodies(daysAgo(30));
    for (const step of await steps(caseId)) {
      assert.equal(step.request, null);
      assert.equal(step.expected, null);
      assert.equal(step.actual, null);
      assert.ok(step.prunedAt, "la marca es lo que distingue esto de un paso que no recibió respuesta");
      assert.equal(step.assertions.length, 1, "la aserción es lo que hace que la fila siga valiendo algo");
      assert.equal(step.ok, true);
    }
  });

  test("no toca una corrida que todavía está corriendo", async () => {
    // `finishedAt` es null mientras corre, y una comparación contra null no es cierta. Sin eso
    // el barrido podría vaciar los cuerpos de un caso que alguien está mirando.
    const { caseId } = await seedRun(null);
    await repository().pruneStepBodies(daysAgo(0));
    assert.ok((await steps(caseId))[0].request, "una corrida en marcha conserva sus cuerpos");
  });

  test("la segunda pasada no reescribe nada", async () => {
    const { caseId } = await seedRun(daysAgo(40));
    const first = await repository().pruneStepBodies(daysAgo(30));
    const marks = (await steps(caseId)).map((step) => step.prunedAt?.getTime());
    await repository().pruneStepBodies(daysAgo(30));
    assert.deepEqual(
      (await steps(caseId)).map((step) => step.prunedAt?.getTime()),
      marks,
      "la marca cambiaría si la fila se hubiera vuelto a escribir",
    );
    assert.equal(first, 2, "los dos pasos de la corrida sembrada, y solo esos");
  });

  test("borrar la corrida se lleva sus casos y sus pasos", async () => {
    // Por la cascada de la migración de corridas. Sin ella quedarían filas que nadie puede ya
    // alcanzar para leer ni para borrar.
    const { runId, caseId } = await seedRun(daysAgo(400));
    assert.ok((await repository().deleteRunsBefore(daysAgo(365))) >= 1);
    assert.deepEqual(await dataSource!.query(`SELECT id FROM runs WHERE id = $1`, [runId]), []);
    assert.deepEqual(await dataSource!.query(`SELECT id FROM run_cases WHERE id = $1`, [caseId]), []);
    assert.deepEqual(await steps(caseId), []);
  });
});

describe("endpoints", { skip: DATABASE_URL ? false : REASON }, () => {
  test("la migración copia como endpoints las operaciones del contrato activo de cada proyecto", async () => {
    const [userId, organizationId, projectId, versionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    // Back to before the table existed, with a project that already has a contract: every
    // migration after the endpoints one is undone first.
    await undoUntil("Endpoints1700000014000");
    try {
      await insertUser(userId, `endpoints-${userId}@example.com`);
      await insertOrganization(organizationId, `o-${organizationId.slice(0, 8)}`);
      await dataSource!.query(
        `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
        [projectId, organizationId, `e-${projectId.slice(0, 8)}`, userId],
      );
      await dataSource!.query(
        `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
         VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 2, '[]'::jsonb, $4, now())`,
        [versionId, projectId, randomUUID().replace(/-/g, ""), userId],
      );
      await dataSource!.query(`UPDATE projects SET "activeSpecVersionId" = $1 WHERE id = $2`, [versionId, projectId]);
      const insertOperation = (
        operationId: string,
        method: string,
        path: string,
        parameters: string[],
        security: string[],
        position: number,
      ) =>
        dataSource!.query(
          `INSERT INTO spec_operations (id, "specVersionId", "operationId", method, path, summary, tag, statuses, parameters, security, position)
           VALUES ($1, $2, $3, $4, $5, 'resumen', 'Things', '[200]'::jsonb, $6::jsonb, $7::jsonb, $8)`,
          [
            randomUUID(),
            versionId,
            operationId,
            method,
            path,
            JSON.stringify(parameters),
            JSON.stringify(security),
            position,
          ],
        );
      await insertOperation("getThing", "get", "/things/{thingId}", ["thingId", "expand"], ["bearer"], 0);
      await insertOperation("listThings", "GET", "/things", [], [], 1);
    } finally {
      await dataSource!.runMigrations();
    }

    const rows: {
      method: string;
      path: string;
      origin: string;
      operationId: string;
      requiresAuth: boolean;
      tags: string[];
      pathParameters: { name: string }[];
      query: { name: string; enabled: boolean }[];
    }[] = await dataSource!.query(`SELECT * FROM endpoints WHERE "projectId" = $1 ORDER BY "orderIndex"`, [projectId]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].method, "GET");
    assert.equal(rows[0].path, "/things/{thingId}");
    assert.equal(rows[0].origin, "contract");
    assert.equal(rows[0].operationId, "getThing");
    assert.equal(rows[0].requiresAuth, true);
    assert.deepEqual(rows[0].tags, ["Things"]);
    assert.deepEqual(
      rows[0].pathParameters.map((parameter) => parameter.name),
      ["thingId"],
    );
    assert.deepEqual(
      rows[0].query.map((row) => [row.name, row.enabled]),
      [["expand", false]],
    );
    assert.equal(rows[1].requiresAuth, false);
    assert.deepEqual(rows[1].query, []);
  });

  test("dos endpoints vivos no comparten método y ruta; uno borrado deja sitio", async () => {
    const [userId, organizationId, projectId] = [randomUUID(), randomUUID(), randomUUID()];
    await insertUser(userId, `endpoints-u-${userId}@example.com`);
    await insertOrganization(organizationId, `o-${organizationId.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [projectId, organizationId, `u-${projectId.slice(0, 8)}`, userId],
    );
    const insert = (deletedAt: string | null) =>
      dataSource!.query(
        `INSERT INTO endpoints (id, "projectId", method, path, "createdAt", "updatedAt", "updatedBy", "deletedAt")
         VALUES ($1, $2, 'GET', '/x', now(), now(), $3, $4)`,
        [randomUUID(), projectId, userId, deletedAt],
      );
    await insert(new Date().toISOString());
    await insert(null);
    await assert.rejects(insert(null), /duplicate key|unique/i);
  });
});

describe("entorno activo y token de sesión", { skip: DATABASE_URL ? false : REASON }, () => {
  test("la migración activa el entorno más antiguo; borrarlo deja la clave en nulo; el token se va con el proyecto", async () => {
    const [userId, organizationId, projectId, older, newer] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await undoUntil("ActiveEnvironmentAndSessionTokens1700000015000");
    try {
      await insertUser(userId, `active-${userId}@example.com`);
      await insertOrganization(organizationId, `o-${organizationId.slice(0, 8)}`);
      await dataSource!.query(
        `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
        [projectId, organizationId, `a-${projectId.slice(0, 8)}`, userId],
      );
      const insertEnvironment = (id: string, name: string, createdAt: string) =>
        dataSource!.query(
          `INSERT INTO environments (id, "projectId", name, "baseUrl", "createdAt") VALUES ($1, $2, $3, 'http://x', $4)`,
          [id, projectId, name, createdAt],
        );
      await insertEnvironment(newer, "staging", "2026-02-01T00:00:00Z");
      await insertEnvironment(older, "local", "2026-01-01T00:00:00Z");
    } finally {
      await dataSource!.runMigrations();
    }

    const active = async () =>
      (
        (await dataSource!.query(`SELECT "activeEnvironmentId" FROM projects WHERE id = $1`, [projectId])) as {
          activeEnvironmentId: string | null;
        }[]
      )[0].activeEnvironmentId;
    assert.equal(await active(), older);

    await dataSource!.query(`DELETE FROM environments WHERE id = $1`, [older]);
    assert.equal(await active(), null);

    await dataSource!.query(
      `INSERT INTO session_tokens ("actorId", "projectId", "tokenCiphertext", "capturedAt", source) VALUES ($1, $2, 'v1.x', now(), 'script')`,
      [userId, projectId],
    );
    await assert.rejects(
      dataSource!.query(
        `INSERT INTO session_tokens ("actorId", "projectId", "tokenCiphertext", "capturedAt", source) VALUES ($1, $2, 'v1.y', now(), 'login')`,
        [userId, projectId],
      ),
      /duplicate key|unique/i,
    );
    await dataSource!.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    const left: unknown[] = await dataSource!.query(`SELECT 1 FROM session_tokens WHERE "projectId" = $1`, [projectId]);
    assert.equal(left.length, 0);
  });
});

describe("roles", { skip: DATABASE_URL ? false : REASON }, () => {
  test("la migración convierte access en roles y permisos; un nombre por proyecto; un rol no es regla sobre sí", async () => {
    const [userId, organizationId, projectId, endpointId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await undoUntil("Roles1700000016000");
    try {
      await insertUser(userId, `roles-${userId}@example.com`);
      await insertOrganization(organizationId, `o-${organizationId.slice(0, 8)}`);
      await dataSource!.query(
        `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
        [projectId, organizationId, `r-${projectId.slice(0, 8)}`, userId],
      );
      await dataSource!.query(
        `INSERT INTO endpoints (id, "projectId", method, path, "operationId", "createdAt", "updatedAt", "updatedBy")
         VALUES ($1, $2, 'GET', '/orders', 'listOrders', now(), now(), $3)`,
        [endpointId, projectId, userId],
      );
      await dataSource!.query(
        `INSERT INTO project_config ("projectId", section, data, "updatedAt", "updatedBy") VALUES ($1, 'access', $2::jsonb, now(), $3)`,
        [
          projectId,
          JSON.stringify({
            access: {
              roles: ["vendedor", "comprador"],
              deniedStatuses: [403, 404],
              rules: [{ operationId: "listOrders", allow: ["vendedor"], deny: ["comprador"] }],
              crossRole: [],
            },
          }),
          userId,
        ],
      );
    } finally {
      await dataSource!.runMigrations();
    }

    const roles: { id: string; name: string; color: string; position: number }[] = await dataSource!.query(
      `SELECT id, name, color, position FROM project_roles WHERE "projectId" = $1 ORDER BY position`,
      [projectId],
    );
    assert.deepEqual(
      roles.map((role) => [role.name, role.color, role.position]),
      [
        ["vendedor", "#6366f1", 0],
        ["comprador", "#8b5cf6", 1],
      ],
    );
    const cells: { roleId: string; access: string }[] = await dataSource!.query(
      `SELECT "roleId", access FROM role_endpoint_permissions WHERE "endpointId" = $1`,
      [endpointId],
    );
    assert.deepEqual(cells.map((cell) => [roles.find((role) => role.id === cell.roleId)!.name, cell.access]).sort(), [
      ["comprador", "deny"],
      ["vendedor", "allow"],
    ]);

    await assert.rejects(
      dataSource!.query(
        `INSERT INTO project_roles (id, "projectId", name, color, "createdAt", "updatedAt") VALUES ($1, $2, 'vendedor', '#000000', now(), now())`,
        [randomUUID(), projectId],
      ),
      /duplicate key|unique/i,
    );
    await assert.rejects(
      dataSource!.query(
        `INSERT INTO role_rules ("projectId", "sourceRoleId", "targetRoleId", "canRead") VALUES ($1, $2, $2, true)`,
        [projectId, roles[0].id],
      ),
      /check constraint/i,
    );
    await dataSource!.query(`DELETE FROM project_roles WHERE id = $1`, [roles[0].id]);
    const left: unknown[] = await dataSource!.query(`SELECT 1 FROM role_endpoint_permissions WHERE "roleId" = $1`, [
      roles[0].id,
    ]);
    assert.equal(left.length, 0);
  });
});

describe("los canales", { skip: DATABASE_URL ? false : REASON }, () => {
  /**
   * Lo que la migración de los canales promete y solo una base de verdad puede comprobar: que borrar
   * un proyecto se lleva sus canales, sus sesiones y sus mensajes —la transcripción de una sesión
   * de un proyecto que ya no existe no es historial, es datos de tráfico sueltos— y que la clave de
   * un mensaje es `(sessionId, seq)` y no admite dos mensajes en el mismo sitio de la conversación.
   */
  test("un proyecto borrado se lleva canales, sesiones y mensajes; y un seq no se repite", async () => {
    const user = randomUUID();
    const organization = randomUUID();
    const project = randomUUID();
    const channel = randomUUID();
    const session = randomUUID();
    await insertUser(user, `canales-${user}@example.test`);
    await insertOrganization(organization, `canales-${organization.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [project, organization, `p-${project.slice(0, 8)}`, user],
    );
    await dataSource!.query(
      `INSERT INTO channel_endpoints (id, "projectId", protocol, name, url, limits, "createdAt", "updatedAt")
       VALUES ($1, $2, 'ws', 'eco', 'wss://eco.example.test', '{}', now(), now())`,
      [channel, project],
    );
    await dataSource!.query(
      `INSERT INTO channel_sessions (id, "channelId", "projectId", status, counters, "ownerInstance", "heartbeatAt", "openedAt", "startedBy")
       VALUES ($1, $2, $3, 'closed', '{}', 'a', now(), now(), $4)`,
      [session, channel, project, user],
    );
    const message = (seq: number) =>
      dataSource!.query(
        `INSERT INTO channel_messages ("sessionId", seq, direction, kind, "atMs", bytes) VALUES ($1, $2, 'in', 'text', 0, 0)`,
        [session, seq],
      );
    await message(0);
    await message(1);
    await assert.rejects(message(1), /duplicate key/);

    await dataSource!.query(`DELETE FROM projects WHERE id = $1`, [project]);
    const [left] = await dataSource!.query(
      `SELECT (SELECT count(*) FROM channel_endpoints WHERE id = $1)::int AS channels,
              (SELECT count(*) FROM channel_sessions WHERE id = $2)::int AS sessions,
              (SELECT count(*) FROM channel_messages WHERE "sessionId" = $2)::int AS messages`,
      [channel, session],
    );
    assert.deepEqual(left, { channels: 0, sessions: 0, messages: 0 });
  });
});

describe("la captura con varias instancias", { skip: DATABASE_URL ? false : REASON }, () => {
  /**
   * Lo que el repositorio en memoria no puede probar: que `appendNext` es atómico contra Postgres.
   * Veinte escrituras a la vez por el pool —como dos instancias de la API grabando la misma
   * sesión— con tope 7: siete filas, `seq` del 1 al 7 sin huecos ni repetidos, y la cuenta en 7.
   */
  test("appendNext respeta el tope y no repite seq con escrituras a la vez; parar es condicional", async () => {
    const user = randomUUID();
    const organization = randomUUID();
    const project = randomUUID();
    const session = randomUUID();
    await insertUser(user, `captura-${user}@example.test`);
    await insertOrganization(organization, `captura-${organization.slice(0, 8)}`);
    await dataSource!.query(
      `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
      [project, organization, `p-${project.slice(0, 8)}`, user],
    );
    const repository = new TypeOrmCaptureRepository(
      dataSource!.getRepository(CaptureSessionEntity),
      dataSource!.getRepository(CaptureItemEntity),
    );
    const now = new Date();
    await repository.saveSession({
      id: session,
      projectId: project,
      status: "active",
      tokenHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      limits: { durationMs: 60_000, maxRequests: 7, maxBodyBytes: 1024 },
      itemCount: 0,
      startedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      stoppedAt: null,
      stopReason: null,
      startedBy: user,
      decryptHttps: false,
    });
    const item = () => ({
      id: randomUUID(),
      sessionId: session,
      projectId: project,
      at: now,
      method: "GET",
      url: "https://api.example.test/x",
      status: 200,
      encrypted: false,
      requestHeaders: {},
      requestBody: "",
      requestBodyTruncated: false,
      responseHeaders: {},
      responseBody: "",
      responseBodyTruncated: false,
      responseContentType: "",
      durationMs: 1,
      error: null,
    });
    const seqs = await Promise.all(Array.from({ length: 20 }, () => repository.appendNext(item(), 7)));
    assert.deepEqual(
      seqs.filter((seq) => seq !== null).sort((a, b) => a! - b!),
      [1, 2, 3, 4, 5, 6, 7],
    );
    const [row] = await dataSource!.query(`SELECT "itemCount" FROM capture_sessions WHERE id = $1`, [session]);
    assert.equal(row.itemCount, 7);
    const stored = await dataSource!.query(`SELECT seq FROM capture_items WHERE "sessionId" = $1 ORDER BY seq`, [
      session,
    ]);
    assert.deepEqual(
      stored.map((entry: { seq: number }) => entry.seq),
      [1, 2, 3, 4, 5, 6, 7],
    );

    assert.equal(await repository.stopSession(project, session, "manual", now), true);
    assert.equal(await repository.stopSession(project, session, "expired", now), false);
    assert.equal((await repository.findSession(project, session))!.stopReason, "manual");
    assert.equal(await repository.appendNext(item(), 100), null, "una sesión parada no admite más");
    await dataSource!.query(`DELETE FROM projects WHERE id = $1`, [project]);
  });
});

describe("la CA de captura", { skip: DATABASE_URL ? false : REASON }, () => {
  /**
   * Dos instancias que arrancan a la vez generan cada una su CA: solo una puede quedarse, y la
   * segunda escritura no puede reescribirla —un dispositivo que ya instaló la primera dejaría de
   * confiar en el proxy—.
   */
  test("insertIfAbsent se queda con la primera, y la columna solo guarda texto cifrado", async () => {
    const repository = new TypeOrmCaptureAuthorityRepository(dataSource!.getRepository(CaptureAuthorityEntity));
    await dataSource!.query(`DELETE FROM capture_authorities`);
    const first = { certificatePem: "PRIMERA", privateKeyCiphertext: "v1.a.b.c", createdAt: new Date() };
    await repository.insertIfAbsent(first);
    await repository.insertIfAbsent({ ...first, certificatePem: "SEGUNDA", privateKeyCiphertext: "v1.d.e.f" });
    const stored = await repository.find();
    assert.equal(stored?.certificatePem, "PRIMERA");
    assert.equal(stored?.privateKeyCiphertext, "v1.a.b.c");
    await dataSource!.query(`DELETE FROM capture_authorities`);
  });
});

describe("la fila de turnos de seguridad y rendimiento", { skip: DATABASE_URL ? false : REASON }, () => {
  /**
   * Lo que la fila en memoria no puede probar: que empezar es exclusivo contra Postgres. Cinco
   * instancias, cada una con su corrida en la fila, piden turno todas a la vez y varias veces por el
   * pool: sin el candado, dos `UPDATE` sobre filas distintas se verían sin empezar y ganarían las dos.
   */
  test("con cinco instancias pidiendo a la vez empieza una, y la primera en llegar", async () => {
    const store = new TypeOrmExecutionTurnStore(dataSource!);
    const runs = Array.from({ length: 5 }, () => ({ runId: randomUUID(), holder: `i-${randomUUID()}` }));
    for (const run of runs) await store.join("security", run.runId, run.holder);
    // Apuntarse otra vez no cambia el sitio.
    await store.join("security", runs[0].runId, runs[0].holder);

    for (let round = 0; round < 3; round += 1) {
      const started = await Promise.all(
        runs.flatMap((run) => [0, 1].map(() => store.tryStart("security", run.runId, run.holder, 30_000))),
      );
      assert.equal(started.filter(Boolean).length, round === 0 ? 1 : 0, `ronda ${round}: ${started.join()}`);
    }
    const [row]: { runId: string }[] = await dataSource!.query(
      `SELECT "runId" FROM execution_turns WHERE kind = 'security' AND "startedAt" IS NOT NULL`,
    );
    assert.equal(row.runId, runs[0].runId, "empezó una que no era la primera");

    // Otro tipo no espera a este.
    const other = randomUUID();
    await store.join("performance", other, "i-otra");
    assert.equal(await store.tryStart("performance", other, "i-otra", 30_000), true);
    await store.leave(other, "i-otra");

    // Al dejarla, la siguiente en llegar; y dejar una ajena no hace nada.
    await store.leave(runs[0].runId, "i-que-no-es");
    assert.equal(await store.tryStart("security", runs[1].runId, runs[1].holder, 30_000), false);
    await store.leave(runs[0].runId, runs[0].holder);
    assert.equal(await store.tryStart("security", runs[2].runId, runs[2].holder, 30_000), false);
    assert.equal(await store.tryStart("security", runs[1].runId, runs[1].holder, 30_000), true);
    for (const run of runs) await store.leave(run.runId, run.holder);
  });

  test("la fila de una instancia que dejó de latir caduca y la siguiente empieza; latir la mantiene", async () => {
    const store = new TypeOrmExecutionTurnStore(dataSource!);
    const dead = randomUUID();
    const alive = randomUUID();
    await store.join("performance", dead, "i-muerta");
    assert.equal(await store.tryStart("performance", dead, "i-muerta", 30_000), true);
    await store.join("performance", alive, "i-viva");
    // La muerta latió por última vez hace un minuto; la viva, ahora.
    await dataSource!.query(
      `UPDATE execution_turns SET "heartbeatAt" = now() - interval '60 seconds' WHERE "runId" = $1`,
      [dead],
    );
    assert.deepEqual(await store.heartbeat("i-viva"), [alive]);
    assert.equal(await store.tryStart("performance", alive, "i-viva", 90_000), false, "caducó antes de tiempo");
    assert.equal(await store.tryStart("performance", alive, "i-viva", 30_000), true);
    const [{ count }]: { count: string }[] = await dataSource!.query(
      `SELECT count(*) FROM execution_turns WHERE "runId" = $1`,
      [dead],
    );
    assert.equal(Number(count), 0, "la fila muerta sigue ahí");
    assert.deepEqual(await store.heartbeat("i-muerta"), []);
    await store.leave(alive, "i-viva");
  });
});
