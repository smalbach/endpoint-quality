/**
 * The roles adapter against a real Postgres (an isolated schema): ordering, project scoping of the
 * permission matrix (a role id from another project reads nothing), `undecided` as a delete, and the
 * cascade that takes a role's permissions and rules with it.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { RoleEntity, RolePermissionEntity, RoleRuleEntity } from "@/shared/database/entities";
import { TypeOrmRoleRepository } from "@/modules/roles/infrastructure/persistence/typeorm-role.repository";
import type { Role } from "@/modules/roles/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";
import { countRows, insertEndpoint, insertProject } from "@test/support/repos-seed";

const at = (iso: string) => new Date(iso);

describe("TypeOrmRoleRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());

  const repo = () =>
    new TypeOrmRoleRepository(
      db.dataSource.getRepository(RoleEntity),
      db.dataSource.getRepository(RolePermissionEntity),
      db.dataSource.getRepository(RoleRuleEntity),
    );
  const role = (projectId: string, overrides: Partial<Role> = {}): Role => ({
    id: randomUUID(),
    projectId,
    name: `r-${randomUUID().slice(0, 6)}`,
    description: "",
    color: "#6366f1",
    sameRoleDataIsolation: false,
    position: 0,
    createdAt: at("2026-01-01T00:00:00Z"),
    updatedAt: at("2026-01-01T00:00:00Z"),
    ...overrides,
  });

  test("list orders by position then creation, scoped to the project", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const { id: other } = await insertProject(db.dataSource);
    const c = role(pid, { name: "c", position: 1, createdAt: at("2026-01-01T00:00:00Z") });
    const b = role(pid, { name: "b", position: 0, createdAt: at("2026-01-02T00:00:00Z") });
    const a = role(pid, { name: "a", position: 0, createdAt: at("2026-01-01T00:00:00Z") });
    for (const r of [c, b, a, role(other, { name: "x" })]) await repo().save(r);
    assert.deepEqual(
      (await repo().list(pid)).map((r) => r.name),
      ["a", "b", "c"],
    );
  });

  test("findById round-trips and is scoped to the project", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const { id: other } = await insertProject(db.dataSource);
    const r = role(pid, { description: "reads", sameRoleDataIsolation: true, position: 4 });
    await repo().save(r);
    assert.deepEqual(await repo().findById(pid, r.id), r);
    assert.equal(await repo().findById(other, r.id), null);
  });

  test("two roles with the same name in a project collide", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    await repo().save(role(pid, { name: "dup" }));
    await assert.rejects(repo().save(role(pid, { name: "dup" })), /duplicate|unique/i);
  });

  test("applyPermissions writes, overwrites and (undecided) deletes; listPermissions filters", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const admin = role(pid, { name: "admin" });
    const guest = role(pid, { name: "guest" });
    await repo().save(admin);
    await repo().save(guest);
    const e1 = await insertEndpoint(db.dataSource, pid);
    const e2 = await insertEndpoint(db.dataSource, pid);

    await repo().applyPermissions([
      { roleId: admin.id, endpointId: e1, access: "allow", dataScope: "all" },
      { roleId: admin.id, endpointId: e2, access: "allow", dataScope: "own" },
      { roleId: guest.id, endpointId: e1, access: "deny", dataScope: "none" },
    ]);
    await repo().applyPermissions([
      { roleId: admin.id, endpointId: e2, access: "deny", dataScope: "all" },
      { roleId: guest.id, endpointId: e1, access: "undecided", dataScope: "all" },
    ]);

    const sort = <T extends { roleId: string; endpointId: string }>(rows: T[]) =>
      [...rows].sort((x, y) => (x.roleId + x.endpointId).localeCompare(y.roleId + y.endpointId));
    assert.deepEqual(
      sort(await repo().listPermissions(pid)),
      sort([
        { roleId: admin.id, endpointId: e1, access: "allow", dataScope: "all" },
        { roleId: admin.id, endpointId: e2, access: "deny", dataScope: "all" },
      ]),
    );
    assert.deepEqual(await repo().listPermissions(pid, { roleId: guest.id }), []);
    assert.deepEqual(await repo().listPermissions(pid, { endpointId: e2 }), [
      { roleId: admin.id, endpointId: e2, access: "deny", dataScope: "all" },
    ]);
    assert.deepEqual(
      (await repo().listPermissions(pid, { roleId: admin.id, endpointId: e1 })).map((p) => p.access),
      ["allow"],
    );
  });

  test("listPermissions never reads another project's role, and a project without roles is empty", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const { id: other } = await insertProject(db.dataSource);
    const foreign = role(other);
    const mine = role(pid);
    await repo().save(foreign);
    await repo().save(mine);
    const e = await insertEndpoint(db.dataSource, other);
    await repo().applyPermissions([{ roleId: foreign.id, endpointId: e, access: "allow", dataScope: "all" }]);

    assert.deepEqual(await repo().listPermissions(pid, { roleId: foreign.id }), []);
    assert.equal((await repo().listPermissions(other, { roleId: foreign.id })).length, 1);
    const { id: bare } = await insertProject(db.dataSource);
    assert.deepEqual(await repo().listPermissions(bare), []);
  });

  test("applyPermissions is one transaction: a bad row rolls back the good ones", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const r = role(pid);
    await repo().save(r);
    const e = await insertEndpoint(db.dataSource, pid);
    await assert.rejects(
      repo().applyPermissions([
        { roleId: r.id, endpointId: e, access: "allow", dataScope: "all" },
        { roleId: r.id, endpointId: randomUUID(), access: "allow", dataScope: "all" }, // no such endpoint
      ]),
      /foreign key/i,
    );
    assert.deepEqual(await repo().listPermissions(pid), []);
  });

  test("replaceRules replaces the whole set, [] empties it, and another project's stay", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const { id: other } = await insertProject(db.dataSource);
    const [a, b, c] = [role(pid), role(pid), role(pid)];
    const [x, y] = [role(other), role(other)];
    for (const r of [a, b, c, x, y]) await repo().save(r);
    const rule = (projectId: string, s: Role, t: Role, canRead = true) => ({
      projectId,
      sourceRoleId: s.id,
      targetRoleId: t.id,
      canRead,
      canWrite: false,
      canDelete: false,
    });

    await repo().replaceRules(pid, [rule(pid, a, b), rule(pid, b, c)]);
    await repo().replaceRules(other, [rule(other, x, y)]);
    await repo().replaceRules(pid, [rule(pid, c, a, false)]);
    assert.deepEqual(await repo().listRules(pid), [rule(pid, c, a, false)]);

    await repo().replaceRules(pid, []);
    assert.deepEqual(await repo().listRules(pid), []);
    assert.deepEqual(await repo().listRules(other), [rule(other, x, y)]);
  });

  test("remove is scoped to the project and takes the role's permissions and rules with it", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const { id: other } = await insertProject(db.dataSource);
    const a = role(pid);
    const b = role(pid);
    await repo().save(a);
    await repo().save(b);
    const e = await insertEndpoint(db.dataSource, pid);
    await repo().applyPermissions([{ roleId: a.id, endpointId: e, access: "allow", dataScope: "all" }]);
    await repo().replaceRules(pid, [
      { projectId: pid, sourceRoleId: a.id, targetRoleId: b.id, canRead: true, canWrite: true, canDelete: true },
    ]);

    await repo().remove(other, a.id);
    assert.notEqual(await repo().findById(pid, a.id), null);

    await repo().remove(pid, a.id);
    assert.equal(await repo().findById(pid, a.id), null);
    assert.equal(await countRows(db.dataSource, "role_endpoint_permissions", `"roleId" = $1`, [a.id]), 0);
    assert.deepEqual(await repo().listRules(pid), []);
    assert.notEqual(await repo().findById(pid, b.id), null);
  });
});
