/**
 * Parent rows for the `repos-b-*` repository suites: an organization and its projects, so the
 * foreign keys of every tenant-owned table have something to point at.
 *
 * Plain SQL instead of the repositories on purpose: the suites test those repositories, and a
 * seed that went through them would hide a broken `save` behind a broken fixture.
 */
import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";

export type Tenant = { organizationId: string; userId: string; projectId: string; otherProjectId: string };

export async function seedOrganization(dataSource: DataSource): Promise<string> {
  const id = randomUUID();
  await dataSource.query(`INSERT INTO organizations (id, name, slug, "createdAt") VALUES ($1, 'org', $2, now())`, [
    id,
    `org-${id.slice(0, 8)}`,
  ]);
  return id;
}

export async function seedProject(dataSource: DataSource, organizationId: string, createdBy: string): Promise<string> {
  const id = randomUUID();
  await dataSource.query(
    `INSERT INTO projects (id, "organizationId", name, slug, "createdBy", "createdAt") VALUES ($1, $2, 'p', $3, $4, now())`,
    [id, organizationId, `p-${id.slice(0, 8)}`, createdBy],
  );
  return id;
}

/** One organization with two projects: the second one is the tenant whose rows must never leak. */
export async function seedTenant(dataSource: DataSource): Promise<Tenant> {
  const userId = randomUUID();
  const organizationId = await seedOrganization(dataSource);
  const projectId = await seedProject(dataSource, organizationId, userId);
  const otherProjectId = await seedProject(dataSource, organizationId, userId);
  return { organizationId, userId, projectId, otherProjectId };
}

export const deleteProject = (dataSource: DataSource, projectId: string) =>
  dataSource.query(`DELETE FROM projects WHERE id = $1`, [projectId]);

export async function countRows(dataSource: DataSource, table: string, where = "true", params: unknown[] = []) {
  const [row]: { n: number }[] = await dataSource.query(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE ${where}`, params);
  return row.n;
}

/**
 * A repository row without its entity prototype. `deepStrictEqual` compares prototypes, and the
 * repositories that cast the TypeORM row instead of copying it return an `XEntity` instance.
 */
export function plain<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => plain(entry)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) return { ...value };
  return value;
}

/** `new Date(base + seconds)`: timestamps whose order the test decides, not the clock. */
export const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seconds * 1000);
