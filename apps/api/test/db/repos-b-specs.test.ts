/**
 * The spec repository against a real Postgres: versions written together with their operations,
 * the listing that leaves the document out, and the sources a re-import reads.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { SpecOperationEntity, SpecSourceEntity, SpecVersionEntity } from "@/shared/database/entities";
import { TypeOrmSpecRepository } from "@/modules/specs/infrastructure/persistence/typeorm-spec.repository";
import type { SpecOperation, SpecSource, SpecVersion } from "@/modules/specs/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, plain, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

describe("TypeOrmSpecRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmSpecRepository;

  const version = (projectId: string, fields: Partial<SpecVersion> = {}): SpecVersion => ({
    id: randomUUID(),
    projectId,
    sourceId: null,
    hash: createHash("sha256").update(randomUUID()).digest("hex"),
    raw: '{"openapi":"3.1.0"}',
    format: "json",
    openapiVersion: "3.1.0",
    title: "Catalog",
    contractVersion: "1.0.0",
    operationCount: 0,
    problems: [],
    importedBy: tenant.userId,
    importedAt: at(0),
    ...fields,
  });

  const operation = (specVersionId: string, position: number, fields: Record<string, unknown> = {}): SpecOperation =>
    ({
      id: `op${position}`,
      rowId: randomUUID(),
      specVersionId,
      position,
      method: "GET",
      path: `/things/${position}`,
      summary: "",
      tag: "",
      statuses: [200],
      parameters: [],
      security: [],
      derivedId: false,
      requestSchema: null,
      ...fields,
    }) as unknown as SpecOperation;

  const source = (projectId: string, fields: Partial<SpecSource> = {}): SpecSource => ({
    id: randomUUID(),
    projectId,
    kind: "url",
    location: "https://api.example.test/openapi.json",
    headersCiphertext: null,
    createdAt: at(0),
    ...fields,
  });

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmSpecRepository(
      db.dataSource.getRepository(SpecVersionEntity),
      db.dataSource.getRepository(SpecOperationEntity),
      db.dataSource.getRepository(SpecSourceEntity),
      db.dataSource,
    );
  });
  after(async () => db?.drop());

  test("a version round-trips by id and by hash within its project", async () => {
    const saved = version(tenant.projectId, {
      problems: [{ severity: "warning", message: "no servers" }] as unknown as SpecVersion["problems"],
    });
    await repo.saveVersion(saved, []);
    assert.deepEqual(plain(await repo.findVersionById(saved.id)), saved);
    assert.deepEqual(plain(await repo.findVersionByHash(tenant.projectId, saved.hash)), saved);
    assert.equal(await repo.findVersionByHash(tenant.otherProjectId, saved.hash), null);
    assert.equal(await repo.findVersionById(randomUUID()), null);
    assert.deepEqual(plain(await repo.listOperations(saved.id)), [], "no operations written for an empty contract");
  });

  test("a stored null problems document reads back as an empty list", async () => {
    const id = randomUUID();
    await db.dataSource.query(
      `INSERT INTO spec_versions (id, "projectId", hash, raw, format, "openapiVersion", title, "contractVersion", "operationCount", problems, "importedBy", "importedAt")
       VALUES ($1, $2, $3, '{}', 'json', '3.0.0', 't', '1', 0, 'null'::jsonb, $4, now())`,
      [id, tenant.projectId, "n".repeat(64), tenant.userId],
    );
    assert.deepEqual((await repo.findVersionById(id))?.problems, []);
    const listed = (await repo.listVersions(tenant.projectId)).find((v) => v.id === id);
    assert.deepEqual(listed?.problems, []);
  });

  test("the same hash twice in one project is refused, in two projects is fine", async () => {
    const t = await seedTenant(db.dataSource);
    const first = version(t.projectId);
    await repo.saveVersion(first, []);
    await repo.saveVersion(version(t.otherProjectId, { hash: first.hash }), []);
    await assert.rejects(() => repo.saveVersion(version(t.projectId, { hash: first.hash }), []), /duplicate key/);
  });

  test("operations are written with the version and listed in document order", async () => {
    const v = version(tenant.projectId, { operationCount: 3 });
    const ops = [
      operation(v.id, 2, { method: "DELETE", tag: "admin", security: ["bearer"] }),
      operation(v.id, 0, {
        method: "POST",
        summary: "create",
        statuses: [201, 422],
        parameters: ["q"],
        derivedId: true,
        requestSchema: { type: "object", properties: { name: { type: "string" } } },
      }),
      operation(v.id, 1),
    ];
    await repo.saveVersion(v, ops);
    const listed = await repo.listOperations(v.id);
    assert.deepEqual(
      listed,
      [ops[1], ops[2], ops[0]],
      "id is the contract's operationId and rowId the key, in position order",
    );
  });

  test("a failing operation rolls the version back with it", async () => {
    const v = version(tenant.projectId);
    const ops = [operation(v.id, 0, { id: "same" }), operation(v.id, 1, { id: "same" })];
    await assert.rejects(() => repo.saveVersion(v, ops), /duplicate key/);
    assert.equal(await repo.findVersionById(v.id), null, "no version without its operations");
    assert.equal(await countRows(db.dataSource, "spec_operations", `"specVersionId" = $1`, [v.id]), 0);
  });

  test("more operations than one chunk are all stored", async () => {
    const v = version(tenant.projectId);
    const ops = Array.from({ length: 450 }, (_, i) => operation(v.id, i));
    await repo.saveVersion(v, ops);
    const listed = await repo.listOperations(v.id);
    assert.equal(listed.length, 450);
    assert.deepEqual(
      listed.map((o) => o.position),
      ops.map((_, i) => i),
    );
  });

  test("listVersions is newest first, scoped, and leaves the document out", async () => {
    const t = await seedTenant(db.dataSource);
    const old = version(t.projectId, { importedAt: at(1), title: "old" });
    const recent = version(t.projectId, { importedAt: at(5), title: "recent" });
    for (const v of [old, version(t.otherProjectId), recent]) await repo.saveVersion(v, []);
    const listed = await repo.listVersions(t.projectId);
    assert.deepEqual(
      listed.map((v) => v.title),
      ["recent", "old"],
    );
    const { raw: listedRaw, ...listedRest } = plain(listed[0]) as typeof listed[0] & { raw?: unknown };
    assert.equal(listedRaw, undefined, "no raw document in the listing");
    const { raw: _raw, ...summary } = recent;
    assert.deepEqual(listedRest, summary);
  });

  test("deleteVersion takes its operations; deleting the project takes everything", async () => {
    const t = await seedTenant(db.dataSource);
    const v = version(t.projectId);
    await repo.saveVersion(v, [operation(v.id, 0)]);
    await repo.deleteVersion(v.id);
    assert.equal(await repo.findVersionById(v.id), null);
    assert.deepEqual(plain(await repo.listOperations(v.id)), []);

    const kept = version(t.projectId);
    await repo.saveVersion(kept, [operation(kept.id, 0)]);
    await repo.saveSource(source(t.projectId));
    await deleteProject(db.dataSource, t.projectId);
    assert.deepEqual(plain(await repo.listVersions(t.projectId)), []);
    assert.equal(await repo.findLatestSource(t.projectId), null);
    assert.equal(await countRows(db.dataSource, "spec_operations", `"specVersionId" = $1`, [kept.id]), 0);
  });

  test("sources: found by kind and location, and the latest one per project", async () => {
    const t = await seedTenant(db.dataSource);
    assert.equal(await repo.findLatestSource(t.projectId), null);
    const url = source(t.projectId, { createdAt: at(1), headersCiphertext: "v1.h" });
    const upload = source(t.projectId, { kind: "upload", location: "spec.yaml", createdAt: at(5) });
    for (const s of [url, upload, source(t.otherProjectId, { createdAt: at(9) })]) await repo.saveSource(s);

    assert.deepEqual(plain(await repo.findSourceByLocation(t.projectId, "url", url.location)), url);
    assert.equal(await repo.findSourceByLocation(t.projectId, "upload", url.location), null);
    assert.equal(await repo.findSourceByLocation(t.otherProjectId, "upload", "spec.yaml"), null);
    assert.deepEqual(plain(await repo.findLatestSource(t.projectId)), upload);

    await repo.saveSource({ ...url, createdAt: at(10) });
    assert.equal((await repo.findLatestSource(t.projectId))?.id, url.id, "saving again updates in place");
  });

  test("deleting a source leaves its versions with a null sourceId", async () => {
    const s = source(tenant.projectId);
    await repo.saveSource(s);
    const v = version(tenant.projectId, { sourceId: s.id });
    await repo.saveVersion(v, []);
    assert.equal((await repo.findVersionById(v.id))?.sourceId, s.id);
    await db.dataSource.query(`DELETE FROM spec_sources WHERE id = $1`, [s.id]);
    assert.equal((await repo.findVersionById(v.id))?.sourceId, null);
  });
});
