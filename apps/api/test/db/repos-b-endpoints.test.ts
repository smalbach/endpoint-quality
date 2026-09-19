/**
 * The endpoint and example repositories against a real Postgres: the filtered, paged list, the
 * counts, soft deletion and the partial unique index, and the examples that hang off an endpoint.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { EndpointEntity, EndpointExampleEntity } from "@/shared/database/entities";
import { TypeOrmEndpointRepository } from "@/modules/endpoints/infrastructure/persistence/typeorm-endpoint.repository";
import { TypeOrmExampleRepository } from "@/modules/endpoints/infrastructure/persistence/typeorm-example.repository";
import type { Endpoint } from "@/modules/endpoints/domain/model";
import type { EndpointExample } from "@/modules/endpoints/domain/examples";
import type { EndpointFilter } from "@/modules/endpoints/domain/ports";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, plain, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

function endpoint(tenant: Tenant, fields: Record<string, unknown> = {}): Endpoint {
  return {
    id: randomUUID(),
    projectId: tenant.projectId,
    method: "GET",
    path: `/items/${randomUUID().slice(0, 6)}`,
    description: "",
    pathParameters: [],
    query: [],
    headers: [],
    body: { type: "none" },
    requiresAuth: false,
    auth: { type: "inherit", params: {} },
    tags: [],
    status: "active",
    origin: "manual",
    operationId: null,
    orderIndex: 0,
    preRequestScript: "",
    postResponseScript: "",
    createdAt: at(0),
    updatedAt: at(0),
    updatedBy: tenant.userId,
    deletedAt: null,
    ...fields,
  } as unknown as Endpoint;
}

const filter = (fields: Partial<EndpointFilter> = {}): EndpointFilter => ({
  status: "all",
  search: "",
  offset: 0,
  limit: 100,
  ...fields,
});

describe("TypeOrmEndpointRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let repo: TypeOrmEndpointRepository;

  before(async () => {
    db = await openIsolatedDb();
    repo = new TypeOrmEndpointRepository(db.dataSource.getRepository(EndpointEntity));
  });
  after(async () => db?.drop());

  test("round-trips an endpoint with its jsonb columns and nulls", async () => {
    const t = await seedTenant(db.dataSource);
    const saved = endpoint(t, {
      description: "list items",
      query: [{ name: "q", value: "1", enabled: true }],
      body: { type: "json", content: "{}" },
      tags: ["a"],
      operationId: "listItems",
      preRequestScript: "pm.x()",
    });
    await repo.save(saved);
    assert.deepEqual(plain(await repo.findById(t.projectId, saved.id)), saved);
  });

  test("findById hides another project's and deleted endpoints", async () => {
    const t = await seedTenant(db.dataSource);
    const saved = endpoint(t);
    await repo.save(saved);
    assert.equal(await repo.findById(t.otherProjectId, saved.id), null);
    assert.equal(await repo.findById(t.projectId, randomUUID()), null);
    assert.equal(await repo.softDelete(t.projectId, [saved.id], at(5)), 1);
    assert.equal(await repo.findById(t.projectId, saved.id), null);
  });

  test("list filters by status and by an escaped search over path and description, and pages", async () => {
    const t = await seedTenant(db.dataSource);
    const a = endpoint(t, { path: "/users", orderIndex: 0, description: "people" });
    const b = endpoint(t, { path: "/user_roles", orderIndex: 1 });
    const c = endpoint(t, { path: "/userXroles", orderIndex: 2, status: "archived" });
    const d = endpoint(t, { path: "/orders", orderIndex: 3, description: "100% of them", status: "inactive" });
    const gone = endpoint(t, { path: "/users/gone", deletedAt: at(1) });
    const foreign = endpoint({ ...t, projectId: t.otherProjectId }, { path: "/users" });
    await repo.saveMany([d, c, b, a, gone, foreign]);

    const all = await repo.list(t.projectId, filter());
    assert.equal(all.total, 4);
    assert.deepEqual(
      all.rows.map((e) => e.path),
      ["/users", "/user_roles", "/userXroles", "/orders"],
    );

    assert.deepEqual(
      (await repo.list(t.projectId, filter({ status: "archived" }))).rows.map((e) => e.path),
      ["/userXroles"],
    );
    assert.deepEqual(
      (await repo.list(t.projectId, filter({ search: "user_" }))).rows.map((e) => e.path),
      ["/user_roles"],
      "an underscore is a character, not a wildcard",
    );
    assert.deepEqual(
      (await repo.list(t.projectId, filter({ search: "100%" }))).rows.map((e) => e.path),
      ["/orders"],
      "matches the description, with % taken literally",
    );
    assert.deepEqual(
      (await repo.list(t.projectId, filter({ search: "PEOPLE" }))).rows.map((e) => e.path),
      ["/users"],
      "case-insensitive",
    );
    assert.deepEqual((await repo.list(t.projectId, filter({ search: "\\" }))).rows, []);
    const combined = await repo.list(t.projectId, filter({ status: "active", search: "user" }));
    assert.deepEqual(
      combined.rows.map((e) => e.path),
      ["/users", "/user_roles"],
    );

    const page = await repo.list(t.projectId, filter({ offset: 1, limit: 2 }));
    assert.equal(page.total, 4, "the total ignores the page");
    assert.deepEqual(
      page.rows.map((e) => e.path),
      ["/user_roles", "/userXroles"],
    );
  });

  test("list breaks orderIndex ties by creation time then path", async () => {
    const t = await seedTenant(db.dataSource);
    const z = endpoint(t, { path: "/z", createdAt: at(1) });
    const y = endpoint(t, { path: "/y", createdAt: at(2) });
    const x = endpoint(t, { path: "/x", createdAt: at(2) });
    await repo.saveMany([y, z, x]);
    assert.deepEqual(
      (await repo.list(t.projectId, filter())).rows.map((e) => e.path),
      ["/z", "/x", "/y"],
    );
    assert.deepEqual(
      (await repo.listAll(t.projectId)).map((e) => e.path),
      ["/x", "/y", "/z"],
      "listAll orders by orderIndex then path",
    );
  });

  test("counts per status, with zeros for the missing ones and without deleted rows", async () => {
    const t = await seedTenant(db.dataSource);
    assert.deepEqual(plain(await repo.counts(t.projectId)), { active: 0, archived: 0, inactive: 0 });
    await repo.saveMany([
      endpoint(t),
      endpoint(t),
      endpoint(t, { status: "archived" }),
      endpoint(t, { deletedAt: at(1) }),
      endpoint({ ...t, projectId: t.otherProjectId }, { status: "inactive" }),
    ]);
    assert.deepEqual(plain(await repo.counts(t.projectId)), { active: 2, archived: 1, inactive: 0 });
  });

  test("the live method+path is unique, but a deleted one frees it", async () => {
    const t = await seedTenant(db.dataSource);
    const first = endpoint(t, { path: "/dup" });
    await repo.save(first);
    await assert.rejects(() => repo.save(endpoint(t, { path: "/dup" })), /duplicate key/);
    await repo.save(endpoint(t, { path: "/dup", method: "POST" }));
    await repo.save(endpoint({ ...t, projectId: t.otherProjectId }, { path: "/dup" }));
    await repo.softDelete(t.projectId, [first.id], at(1));
    await repo.save(endpoint(t, { path: "/dup" }));
    assert.equal((await repo.listAll(t.projectId)).filter((e) => e.path === "/dup").length, 2);
  });

  test("saveMany is all or nothing, and an empty batch writes nothing", async () => {
    const t = await seedTenant(db.dataSource);
    await repo.saveMany([]);
    assert.equal(await countRows(db.dataSource, "endpoints", `"projectId" = $1`, [t.projectId]), 0);
    await assert.rejects(() => repo.saveMany([endpoint(t, { path: "/same" }), endpoint(t, { path: "/same" })]));
    assert.equal(await countRows(db.dataSource, "endpoints", `"projectId" = $1`, [t.projectId]), 0);
  });

  test("setStatus touches only live rows of the project and reports how many", async () => {
    const t = await seedTenant(db.dataSource);
    const a = endpoint(t);
    const b = endpoint(t);
    const deleted = endpoint(t, { deletedAt: at(1) });
    const foreign = endpoint({ ...t, projectId: t.otherProjectId });
    await repo.saveMany([a, b, deleted, foreign]);

    assert.equal(await repo.setStatus(t.projectId, [], "archived", at(9), t.userId), 0);
    const actor = randomUUID();
    assert.equal(
      await repo.setStatus(t.projectId, [a.id, deleted.id, foreign.id], "archived", at(9), actor),
      1,
    );
    const updated = await repo.findById(t.projectId, a.id);
    assert.equal(updated?.status, "archived");
    assert.equal(updated?.updatedBy, actor);
    assert.equal(updated?.updatedAt.getTime(), at(9).getTime());
    assert.equal((await repo.findById(t.projectId, b.id))?.status, "active");
    assert.equal((await repo.findById(t.otherProjectId, foreign.id))?.status, "active");
  });

  test("softDelete skips the already deleted and another project's rows", async () => {
    const t = await seedTenant(db.dataSource);
    const a = endpoint(t);
    const foreign = endpoint({ ...t, projectId: t.otherProjectId });
    await repo.saveMany([a, foreign]);
    assert.equal(await repo.softDelete(t.projectId, [], at(1)), 0);
    assert.equal(await repo.softDelete(t.projectId, [a.id, foreign.id], at(1)), 1);
    assert.equal(await repo.softDelete(t.projectId, [a.id], at(2)), 0, "deleting twice changes nothing");
    const [row] = await db.dataSource.query(`SELECT "deletedAt" FROM endpoints WHERE id = $1`, [a.id]);
    assert.equal(row.deletedAt.getTime(), at(1).getTime());
    assert.ok(await repo.findById(t.otherProjectId, foreign.id));
  });

  test("nextOrderIndex is one past the highest, deleted rows included, and 0 for an empty project", async () => {
    const t = await seedTenant(db.dataSource);
    assert.equal(await repo.nextOrderIndex(t.projectId), 0);
    await repo.saveMany([endpoint(t, { orderIndex: 3 }), endpoint(t, { orderIndex: 7, deletedAt: at(1) })]);
    assert.equal(await repo.nextOrderIndex(t.projectId), 8);
    assert.equal(await repo.nextOrderIndex(t.otherProjectId), 0);
  });
});

describe("TypeOrmExampleRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let endpoints: TypeOrmEndpointRepository;
  let repo: TypeOrmExampleRepository;

  const example = (endpointOwner: Endpoint, fields: Record<string, unknown> = {}): EndpointExample =>
    ({
      id: randomUUID(),
      projectId: endpointOwner.projectId,
      endpointId: endpointOwner.id,
      name: `ex-${randomUUID().slice(0, 6)}`,
      request: { method: "GET", url: "/x", headers: [] },
      response: { status: 200, headers: [], body: "{}" },
      origin: "manual",
      orderIndex: 0,
      createdAt: at(0),
      updatedAt: at(0),
      createdBy: endpointOwner.updatedBy,
      ...fields,
    }) as unknown as EndpointExample;

  before(async () => {
    db = await openIsolatedDb();
    endpoints = new TypeOrmEndpointRepository(db.dataSource.getRepository(EndpointEntity));
    repo = new TypeOrmExampleRepository(db.dataSource.getRepository(EndpointExampleEntity));
  });
  after(async () => db?.drop());

  async function withEndpoint(): Promise<{ t: Tenant; e: Endpoint; other: Endpoint }> {
    const t = await seedTenant(db.dataSource);
    const e = endpoint(t);
    const other = endpoint(t);
    await endpoints.saveMany([e, other]);
    return { t, e, other };
  }

  test("round-trips an example and scopes findById and remove to the project", async () => {
    const { t, e } = await withEndpoint();
    const saved = example(e, { origin: "response", orderIndex: 2 });
    await repo.save(saved);
    assert.deepEqual(plain(await repo.findById(t.projectId, saved.id)), saved);
    assert.equal(await repo.findById(t.otherProjectId, saved.id), null);
    assert.equal(await repo.remove(t.otherProjectId, saved.id), false);
    assert.equal(await repo.remove(t.projectId, saved.id), true);
    assert.equal(await repo.findById(t.projectId, saved.id), null);
    assert.equal(await repo.remove(t.projectId, saved.id), false);
  });

  test("lists by endpoint in orderIndex then creation order, and counts", async () => {
    const { t, e, other } = await withEndpoint();
    const second = example(e, { name: "second", orderIndex: 1 });
    const firstOld = example(e, { name: "first-old", orderIndex: 0, createdAt: at(1) });
    const firstNew = example(e, { name: "first-new", orderIndex: 0, createdAt: at(2) });
    const elsewhere = example(other, { name: "elsewhere" });
    await repo.saveMany([second, firstNew, elsewhere, firstOld]);

    assert.deepEqual(
      (await repo.listByEndpoint(t.projectId, e.id)).map((x) => x.name),
      ["first-old", "first-new", "second"],
    );
    assert.equal(await repo.countByEndpoint(t.projectId, e.id), 3);
    assert.equal(await repo.countByEndpoint(t.projectId, other.id), 1);
    assert.equal(await repo.countByEndpoint(t.otherProjectId, e.id), 0);
    assert.deepEqual(plain(await repo.listByEndpoint(t.otherProjectId, e.id)), []);

    const byProject = await repo.listByProject(t.projectId);
    const expectedEndpointOrder = [e.id, other.id].sort();
    assert.deepEqual(
      [...new Set(byProject.map((x) => x.endpointId))],
      expectedEndpointOrder,
      "grouped by endpoint",
    );
    assert.equal(byProject.length, 4);
    assert.deepEqual(plain(await repo.listByProject(t.otherProjectId)), []);
  });

  test("saveMany of nothing is a no-op, and a name is unique per endpoint", async () => {
    const { t, e, other } = await withEndpoint();
    await repo.saveMany([]);
    assert.equal(await repo.countByEndpoint(t.projectId, e.id), 0);
    await repo.save(example(e, { name: "ok" }));
    await repo.save(example(other, { name: "ok" }));
    await assert.rejects(() => repo.save(example(e, { name: "ok" })), /duplicate key/);
  });

  test("save updates an example in place", async () => {
    const { t, e } = await withEndpoint();
    const saved = example(e, { name: "v1" });
    await repo.save(saved);
    await repo.save({ ...saved, name: "v2" } as EndpointExample);
    assert.equal((await repo.findById(t.projectId, saved.id))?.name, "v2");
    assert.equal(await repo.countByEndpoint(t.projectId, e.id), 1);
  });

  test("deleting the endpoint row or the project cascades to the examples", async () => {
    const { t, e, other } = await withEndpoint();
    await repo.saveMany([example(e), example(other)]);
    await db.dataSource.query(`DELETE FROM endpoints WHERE id = $1`, [e.id]);
    assert.equal(await repo.countByEndpoint(t.projectId, e.id), 0);
    assert.equal(await repo.countByEndpoint(t.projectId, other.id), 1);
    await deleteProject(db.dataSource, t.projectId);
    assert.equal(await countRows(db.dataSource, "endpoint_examples", `"projectId" = $1`, [t.projectId]), 0);
  });
});
