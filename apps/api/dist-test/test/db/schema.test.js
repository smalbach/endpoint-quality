"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const typeorm_1 = require("typeorm");
const data_source_1 = require("../../src/shared/database/data-source");
const DATABASE_URL = process.env.EQ_TEST_DATABASE_URL;
const REASON = "sin EQ_TEST_DATABASE_URL: levanta Postgres (docker compose -f docker/compose.yml up -d postgres) y reexporta la variable";
let dataSource;
(0, node_test_1.before)(async () => {
    if (!DATABASE_URL)
        return;
    dataSource = new typeorm_1.DataSource((0, data_source_1.buildDataSourceOptions)(DATABASE_URL));
    await dataSource.initialize();
    // Applied forwards from empty on every run: a migration that only works against a database
    // that already has the tables is not a migration.
    await dataSource.runMigrations();
});
(0, node_test_1.after)(async () => {
    if (dataSource?.isInitialized)
        await dataSource.destroy();
});
const insertUser = (id, email) => dataSource.query(`INSERT INTO users (id, email, name, "passwordDigest", status, "createdAt") VALUES ($1, $2, 'x', 'x', 'active', now())`, [id, email]);
const insertOrganization = (id, slug) => dataSource.query(`INSERT INTO organizations (id, name, slug, "createdAt") VALUES ($1, 'x', $2, now())`, [id, slug]);
(0, node_test_1.describe)("migraciones", { skip: DATABASE_URL ? false : REASON }, () => {
    (0, node_test_1.test)("crean todas las tablas del esquema inicial", async () => {
        const rows = await dataSource.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'migrations'`);
        const tables = rows.map((row) => row.table_name).sort();
        strict_1.default.deepEqual(tables, [
            "api_tokens", "invitations", "memberships", "organizations", "projects",
            "refresh_tokens", "spec_operations", "spec_sources", "spec_versions", "users",
        ]);
    });
    (0, node_test_1.test)("son reversibles: cada down deshace su up y up lo reconstruye", async () => {
        // A migration nobody has ever reverted is a migration that cannot be reverted, and that is
        // discovered during the incident rather than before it. Both are undone, in order, because
        // the second adds a foreign key into a table the first creates — reverting only the last
        // would leave a constraint pointing at a table about to disappear.
        const exists = async (table) => (await dataSource.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [table])).length;
        await dataSource.undoLastMigration();
        strict_1.default.equal(await exists("spec_versions"), 0);
        strict_1.default.equal(await exists("users"), 1, "revertir la segunda migración no debe tocar la primera");
        await dataSource.undoLastMigration();
        strict_1.default.equal(await exists("users"), 0);
        await dataSource.runMigrations();
        strict_1.default.equal(await exists("users"), 1);
        strict_1.default.equal(await exists("spec_operations"), 1);
    });
    (0, node_test_1.test)("correr las migraciones dos veces no hace nada la segunda", async () => {
        strict_1.default.deepEqual(await dataSource.runMigrations(), []);
    });
});
(0, node_test_1.describe)("restricciones que solo existen en SQL", { skip: DATABASE_URL ? false : REASON }, () => {
    (0, node_test_1.test)("dos cuentas no pueden compartir correo", async () => {
        const email = `dup-${(0, node_crypto_1.randomUUID)()}@example.com`;
        await insertUser((0, node_crypto_1.randomUUID)(), email);
        await strict_1.default.rejects(insertUser((0, node_crypto_1.randomUUID)(), email), /duplicate key|unique/i);
    });
    (0, node_test_1.test)("dos organizaciones no pueden compartir slug", async () => {
        const slug = `slug-${(0, node_crypto_1.randomUUID)().slice(0, 8)}`;
        await insertOrganization((0, node_crypto_1.randomUUID)(), slug);
        await strict_1.default.rejects(insertOrganization((0, node_crypto_1.randomUUID)(), slug), /duplicate key|unique/i);
    });
    (0, node_test_1.test)("una membresía no puede apuntar a una organización inexistente", async () => {
        // Without the foreign key, a delete elsewhere leaves a membership granting a role in
        // something that no longer exists — and the role check would still pass.
        const userId = (0, node_crypto_1.randomUUID)();
        await insertUser(userId, `fk-${userId}@example.com`);
        await strict_1.default.rejects(dataSource.query(`INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`, [(0, node_crypto_1.randomUUID)(), userId]), /foreign key/i);
    });
    (0, node_test_1.test)("la misma persona no puede estar dos veces en una organización", async () => {
        const [userId, organizationId] = [(0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()];
        await insertUser(userId, `pk-${userId}@example.com`);
        await insertOrganization(organizationId, `pk-${organizationId.slice(0, 8)}`);
        const insert = () => dataSource.query(`INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'viewer', now())`, [organizationId, userId]);
        await insert();
        // Two rows would mean two roles, and which one wins would depend on row order.
        await strict_1.default.rejects(insert(), /duplicate key|unique/i);
    });
    (0, node_test_1.test)("borrar una organización se lleva sus membresías y tokens", async () => {
        const [userId, organizationId] = [(0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()];
        await insertUser(userId, `cascade-${userId}@example.com`);
        await insertOrganization(organizationId, `cascade-${organizationId.slice(0, 8)}`);
        await dataSource.query(`INSERT INTO memberships ("organizationId", "userId", role, "createdAt") VALUES ($1, $2, 'owner', now())`, [organizationId, userId]);
        await dataSource.query(`INSERT INTO api_tokens (id, "organizationId", name, "tokenHash", preview, "createdBy", "createdAt") VALUES ($1, $2, 'ci', $3, 'eqt_ab…cd', $4, now())`, [(0, node_crypto_1.randomUUID)(), organizationId, (0, node_crypto_1.randomUUID)(), userId]);
        await dataSource.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
        // A live API token pointing at a deleted organization is a credential with no owner and no
        // way to revoke it from the UI.
        const tokens = await dataSource.query(`SELECT 1 FROM api_tokens WHERE "organizationId" = $1`, [organizationId]);
        const memberships = await dataSource.query(`SELECT 1 FROM memberships WHERE "organizationId" = $1`, [organizationId]);
        strict_1.default.equal(tokens.length, 0);
        strict_1.default.equal(memberships.length, 0);
    });
    (0, node_test_1.test)("dos refresh tokens no pueden compartir hash", async () => {
        const userId = (0, node_crypto_1.randomUUID)();
        await insertUser(userId, `rt-${userId}@example.com`);
        const hash = (0, node_crypto_1.randomUUID)();
        const insert = () => dataSource.query(`INSERT INTO refresh_tokens (id, "userId", "sessionId", "tokenHash", "expiresAt", "createdAt") VALUES ($1, $2, $3, $4, now() + interval '30 days', now())`, [(0, node_crypto_1.randomUUID)(), userId, (0, node_crypto_1.randomUUID)(), hash]);
        await insert();
        await strict_1.default.rejects(insert(), /duplicate key|unique/i);
    });
    (0, node_test_1.test)("dos proyectos de una organización no pueden compartir slug, pero sí de organizaciones distintas", async () => {
        // Unique per organization. A global namespace would let one customer discover another exists
        // by the suffix their project silently receives.
        const [userId, orgA, orgB] = [(0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()];
        await insertUser(userId, `slug-${userId}@example.com`);
        await insertOrganization(orgA, `a-${orgA.slice(0, 8)}`);
        await insertOrganization(orgB, `b-${orgB.slice(0, 8)}`);
        const insertProject = (organizationId) => dataSource.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', 'catalog', $3, now())`, [(0, node_crypto_1.randomUUID)(), organizationId, userId]);
        await insertProject(orgA);
        await strict_1.default.rejects(insertProject(orgA), /duplicate key|unique/i);
        await insertProject(orgB);
    });
    (0, node_test_1.test)("borrar una versión deja el proyecto en pie sin contrato activo", async () => {
        // SET NULL and not CASCADE: removing a snapshot must not delete the project and everything
        // configured under it.
        const [userId, organizationId, projectId, versionId] = [(0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()];
        await insertUser(userId, `ver-${userId}@example.com`);
        await insertOrganization(organizationId, `v-${organizationId.slice(0, 8)}`);
        await dataSource.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `p-${projectId.slice(0, 8)}`, userId]);
        await dataSource.query(`INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 0, '[]'::jsonb, $4, now())`, [versionId, projectId, (0, node_crypto_1.randomUUID)().replace(/-/g, ""), userId]);
        await dataSource.query(`UPDATE projects SET "activeSpecVersionId" = $1 WHERE id = $2`, [versionId, projectId]);
        await dataSource.query(`DELETE FROM spec_versions WHERE id = $1`, [versionId]);
        const [project] = await dataSource.query(`SELECT "activeSpecVersionId" FROM projects WHERE id = $1`, [projectId]);
        strict_1.default.equal(project.activeSpecVersionId, null);
    });
    (0, node_test_1.test)("borrar una versión se lleva sus operaciones", async () => {
        const [userId, organizationId, projectId, versionId] = [(0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)(), (0, node_crypto_1.randomUUID)()];
        await insertUser(userId, `ops-${userId}@example.com`);
        await insertOrganization(organizationId, `o-${organizationId.slice(0, 8)}`);
        await dataSource.query(`INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`, [projectId, organizationId, `q-${projectId.slice(0, 8)}`, userId]);
        await dataSource.query(`INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, 'x', 'yaml', '3.1.0', 't', '1', 1, '[]'::jsonb, $4, now())`, [versionId, projectId, (0, node_crypto_1.randomUUID)().replace(/-/g, ""), userId]);
        const insertOperation = () => dataSource.query(`INSERT INTO spec_operations (id, "specVersionId", "operationId", method, path, statuses, parameters, security, position)
         VALUES ($1, $2, 'listThings', 'GET', '/things', '[200]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0)`, [(0, node_crypto_1.randomUUID)(), versionId]);
        await insertOperation();
        // Two operations under one id in the same version would share configuration silently.
        await strict_1.default.rejects(insertOperation(), /duplicate key|unique/i);
        await dataSource.query(`DELETE FROM spec_versions WHERE id = $1`, [versionId]);
        const left = await dataSource.query(`SELECT 1 FROM spec_operations WHERE "specVersionId" = $1`, [versionId]);
        strict_1.default.equal(left.length, 0);
    });
    (0, node_test_1.test)("los índices que sostienen cada comprobación de autorización existen", async () => {
        // Every request resolves "what is this user's role here", so this lookup is as hot as the
        // primary key.
        const rows = await dataSource.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('memberships','refresh_tokens','api_tokens','projects','spec_versions','spec_operations')`);
        const names = rows.map((row) => row.indexname);
        for (const expected of [
            "ix_memberships_user", "ix_refresh_tokens_session", "ux_refresh_tokens_hash", "ux_api_tokens_hash",
            // A re-import looks the document up by hash before parsing it; without this index a
            // scheduled drift check scans every version the project ever had.
            "ux_projects_org_slug", "ux_spec_versions_project_hash", "ix_spec_operations_version",
        ]) {
            strict_1.default.ok(names.includes(expected), `falta el índice ${expected}`);
        }
    });
});
//# sourceMappingURL=schema.test.js.map