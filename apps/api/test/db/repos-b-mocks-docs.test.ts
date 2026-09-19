/**
 * The mock-server and doc-site repositories against a real Postgres: two public surfaces of a
 * project, each resolved by an installation-wide `publicId`.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { DocSiteEntity, MockCallEntity, MockServerEntity } from "@/shared/database/entities";
import { TypeOrmMockRepository } from "@/modules/mocks/infrastructure/persistence/typeorm-mock.repository";
import { TypeOrmDocSiteRepository } from "@/modules/docs/infrastructure/persistence/typeorm-doc-site.repository";
import type { MockServer } from "@/modules/mocks/domain/model";
import type { MockCall } from "@/modules/mocks/domain/mock-call";
import type { DocSite } from "@/modules/docs/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, plain, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

const publicId = () => randomUUID().replace(/-/g, "");

describe("TypeOrmMockRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmMockRepository;

  const mock = (projectId: string, fields: Record<string, unknown> = {}): MockServer =>
    ({
      id: randomUUID(),
      projectId,
      name: "mock",
      publicId: publicId(),
      visibility: "public",
      apiKeyHash: null,
      apiKeyPreview: "",
      delay: { kind: "none" },
      enabled: true,
      createdAt: at(0),
      updatedAt: at(0),
      createdBy: tenant.userId,
      ...fields,
    }) as unknown as MockServer;

  const call = (mockServerId: string, fields: Record<string, unknown> = {}): MockCall =>
    ({
      id: randomUUID(),
      mockServerId,
      at: at(0),
      method: "GET",
      path: "/x",
      status: 200,
      exampleId: null,
      exampleName: "",
      missCode: "",
      durationMs: 3,
      ...fields,
    }) as unknown as MockCall;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmMockRepository(
      db.dataSource.getRepository(MockServerEntity),
      db.dataSource.getRepository(MockCallEntity),
    );
  });
  after(async () => db?.drop());

  test("round-trips a mock and resolves it by id within the project or by public id", async () => {
    const saved = mock(tenant.projectId, {
      visibility: "private",
      apiKeyHash: "a".repeat(64),
      apiKeyPreview: "eqm_ab…cd",
      delay: { kind: "fixed", ms: 50 },
      enabled: false,
    });
    await repo.save(saved);
    assert.deepEqual(plain(await repo.findById(tenant.projectId, saved.id)), saved);
    assert.deepEqual(plain(await repo.findByPublicId(saved.publicId)), saved);
    assert.equal(await repo.findById(tenant.otherProjectId, saved.id), null);
    assert.equal(await repo.findByPublicId("missing"), null);
  });

  test("the public id is unique across the whole installation", async () => {
    const shared = publicId();
    await repo.save(mock(tenant.projectId, { publicId: shared }));
    await assert.rejects(() => repo.save(mock(tenant.otherProjectId, { publicId: shared })), /duplicate key/);
  });

  test("listByProject is oldest first and scoped; remove reports whether it removed", async () => {
    const t = await seedTenant(db.dataSource);
    const late = mock(t.projectId, { name: "late", createdAt: at(9) });
    const early = mock(t.projectId, { name: "early", createdAt: at(1) });
    for (const m of [late, mock(t.otherProjectId), early]) await repo.save(m);
    assert.deepEqual(
      (await repo.listByProject(t.projectId)).map((m) => m.name),
      ["early", "late"],
    );
    assert.equal(await repo.remove(t.otherProjectId, early.id), false);
    assert.equal(await repo.remove(t.projectId, early.id), true);
    assert.equal(await repo.remove(t.projectId, early.id), false);
    assert.deepEqual(
      (await repo.listByProject(t.projectId)).map((m) => m.name),
      ["late"],
    );
  });

  test("calls are listed newest first up to the limit, only of that mock", async () => {
    const m = mock(tenant.projectId);
    const other = mock(tenant.projectId);
    await repo.save(m);
    await repo.save(other);
    const hit = call(m.id, { at: at(1), exampleId: randomUUID(), exampleName: "ok" });
    const miss = call(m.id, { at: at(2), status: 404, missCode: "mock-no-route" });
    await repo.saveCall(miss);
    await repo.saveCall(hit);
    await repo.saveCall(call(other.id, { at: at(3) }));
    assert.deepEqual(plain(await repo.listCalls(m.id, 10)), [miss, hit]);
    assert.deepEqual(plain(await repo.listCalls(m.id, 1)), [miss]);
  });

  test("saveCall inserts and never overwrites", async () => {
    const m = mock(tenant.projectId);
    await repo.save(m);
    const c = call(m.id);
    await repo.saveCall(c);
    await assert.rejects(() => repo.saveCall({ ...c, status: 500 } as MockCall), /duplicate key/);
  });

  test("trimCalls keeps the newest by time and is a no-op under the cap", async () => {
    const m = mock(tenant.projectId);
    const other = mock(tenant.projectId);
    await repo.save(m);
    await repo.save(other);
    for (const s of [3, 1, 5, 2, 4]) await repo.saveCall(call(m.id, { at: at(s) }));
    await repo.saveCall(call(other.id, { at: at(0) }));

    await repo.trimCalls(m.id, 5);
    assert.equal((await repo.listCalls(m.id, 100)).length, 5);
    await repo.trimCalls(m.id, 2);
    assert.deepEqual(
      (await repo.listCalls(m.id, 100)).map((c) => c.at.getTime()),
      [at(5).getTime(), at(4).getTime()],
    );
    assert.equal((await repo.listCalls(other.id, 100)).length, 1);
  });

  test("removing a mock, or its project, takes its calls", async () => {
    const t = await seedTenant(db.dataSource);
    const m = mock(t.projectId);
    await repo.save(m);
    await repo.saveCall(call(m.id));
    await repo.remove(t.projectId, m.id);
    assert.equal(await countRows(db.dataSource, "mock_calls", `"mockServerId" = $1`, [m.id]), 0);

    const kept = mock(t.projectId);
    await repo.save(kept);
    await repo.saveCall(call(kept.id));
    await deleteProject(db.dataSource, t.projectId);
    assert.equal(await repo.findByPublicId(kept.publicId), null);
    assert.equal(await countRows(db.dataSource, "mock_calls", `"mockServerId" = $1`, [kept.id]), 0);
  });
});

describe("TypeOrmDocSiteRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmDocSiteRepository;

  const site = (projectId: string, fields: Record<string, unknown> = {}): DocSite =>
    ({
      id: randomUUID(),
      projectId,
      name: "docs",
      publicId: publicId(),
      visibility: "public",
      apiKeyHash: null,
      apiKeyPreview: "",
      baseUrl: "",
      intro: "",
      includeExamples: false,
      enabled: true,
      createdAt: at(0),
      updatedAt: at(0),
      createdBy: tenant.userId,
      ...fields,
    }) as unknown as DocSite;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmDocSiteRepository(db.dataSource.getRepository(DocSiteEntity));
  });
  after(async () => db?.drop());

  test("round-trips a site and resolves it by project-scoped id or by public id", async () => {
    const saved = site(tenant.projectId, {
      visibility: "private",
      apiKeyHash: "b".repeat(64),
      apiKeyPreview: "eqd_ab…cd",
      baseUrl: "https://api.example.test",
      intro: "# Hello",
      includeExamples: true,
    });
    await repo.save(saved);
    assert.deepEqual(plain(await repo.findById(tenant.projectId, saved.id)), saved);
    assert.deepEqual(plain(await repo.findByPublicId(saved.publicId)), saved);
    assert.equal(await repo.findById(tenant.otherProjectId, saved.id), null);
    assert.equal(await repo.findById(tenant.projectId, randomUUID()), null);
    assert.equal(await repo.findByPublicId("missing"), null);
  });

  test("save updates in place; the public id is unique", async () => {
    const saved = site(tenant.projectId);
    await repo.save(saved);
    await repo.save({ ...saved, name: "renamed" } as DocSite);
    assert.equal((await repo.findById(tenant.projectId, saved.id))?.name, "renamed");
    await assert.rejects(() => repo.save(site(tenant.projectId, { publicId: saved.publicId })), /duplicate key/);
  });

  test("listByProject is oldest first and scoped; remove reports whether it removed", async () => {
    const t = await seedTenant(db.dataSource);
    const late = site(t.projectId, { name: "late", createdAt: at(9) });
    const early = site(t.projectId, { name: "early", createdAt: at(1) });
    for (const s of [late, site(t.otherProjectId), early]) await repo.save(s);
    assert.deepEqual(
      (await repo.listByProject(t.projectId)).map((s) => s.name),
      ["early", "late"],
    );
    assert.equal(await repo.remove(t.otherProjectId, late.id), false);
    assert.equal(await repo.remove(t.projectId, late.id), true);
    assert.equal(await repo.remove(t.projectId, late.id), false);
    await deleteProject(db.dataSource, t.projectId);
    assert.deepEqual(plain(await repo.listByProject(t.projectId)), []);
  });
});
