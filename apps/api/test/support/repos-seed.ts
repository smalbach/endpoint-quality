/**
 * Parent rows for repository tests against a real (isolated) Postgres schema.
 *
 * Raw SQL on purpose: these helpers only have to satisfy the foreign keys of the table under
 * test, and going through the entities would exercise the very mapping a test is trying to check.
 * Every helper takes optional overrides and returns the id it wrote.
 *
 * Use with `openIsolatedDb()` from `./isolated-db`: its `search_path` points at the private schema,
 * so unqualified table names land there and never in `public`.
 */
import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";

type Overrides = Record<string, unknown>;

/** `INSERT INTO "<table>" (...) VALUES (...)` from a plain object; keys are column names. */
export async function insertRow(ds: DataSource, table: string, row: Overrides): Promise<void> {
  const columns = Object.keys(row);
  const values = columns.map((column) => {
    const value = row[column];
    // jsonb columns: objects and arrays go as JSON text; Dates and Buffers go as they are.
    if (value !== null && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value))
      return JSON.stringify(value);
    return value;
  });
  await ds.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    values,
  );
}

const unique = () => randomUUID().slice(0, 8);

export async function insertUser(ds: DataSource, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "users", {
    id,
    email: `user-${unique()}@example.test`,
    name: "Test User",
    passwordDigest: "digest",
    status: "active",
    createdAt: new Date(),
    ...overrides,
  });
  return id;
}

export async function insertOrganization(ds: DataSource, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "organizations", {
    id,
    name: "Org",
    slug: `org-${unique()}`,
    createdAt: new Date(),
    ...overrides,
  });
  return id;
}

/** A project; creates its organization when `organizationId` is not given. */
export async function insertProject(
  ds: DataSource,
  overrides: Overrides = {},
): Promise<{ id: string; organizationId: string }> {
  const id = (overrides.id as string) ?? randomUUID();
  const organizationId = (overrides.organizationId as string) ?? (await insertOrganization(ds));
  await insertRow(ds, "projects", {
    id,
    organizationId,
    name: "Project",
    slug: `p-${unique()}`,
    createdBy: randomUUID(),
    createdAt: new Date(),
    ...overrides,
  });
  return { id, organizationId };
}

export async function insertEnvironment(ds: DataSource, projectId: string, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "environments", {
    id,
    projectId,
    name: `env-${unique()}`,
    baseUrl: "http://localhost",
    createdAt: new Date(),
    ...overrides,
  });
  return id;
}

export async function insertEndpoint(ds: DataSource, projectId: string, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "endpoints", {
    id,
    projectId,
    method: "GET",
    path: `/things/${unique()}`,
    body: { type: "none" },
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: randomUUID(),
    ...overrides,
  });
  return id;
}

export async function insertWorkflow(ds: DataSource, projectId: string, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "workflows", {
    id,
    projectId,
    name: `wf-${unique()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: randomUUID(),
    ...overrides,
  });
  return id;
}

export async function insertChannel(ds: DataSource, projectId: string, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "channel_endpoints", {
    id,
    projectId,
    protocol: "ws",
    name: `ch-${unique()}`,
    url: "ws://localhost/socket",
    limits: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

export async function insertRole(ds: DataSource, projectId: string, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "project_roles", {
    id,
    projectId,
    name: `r-${unique()}`,
    color: "#112233",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return id;
}

/** A run without a contract (`specVersionId` null), which the schema allows since migration 40000. */
export async function insertRun(ds: DataSource, projectId: string, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "runs", {
    id,
    projectId,
    status: "queued",
    plan: {},
    totals: {},
    triggeredByKind: "user",
    triggeredBy: randomUUID(),
    startedAt: new Date(),
    ...overrides,
  });
  return id;
}

export async function insertRunCase(ds: DataSource, runId: string, overrides: Overrides = {}): Promise<string> {
  const id = (overrides.id as string) ?? randomUUID();
  await insertRow(ds, "run_cases", {
    id,
    runId,
    operationId: "op",
    scenarioId: "sc",
    method: "GET",
    path: "/x",
    status: "pending",
    position: 0,
    ...overrides,
  });
  return id;
}

/** How many rows `table` holds matching `where` (a SQL fragment with `$n` params). */
export async function countRows(ds: DataSource, table: string, where = "true", params: unknown[] = []): Promise<number> {
  const [row] = (await ds.query(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE ${where}`, params)) as { n: number }[];
  return row.n;
}
