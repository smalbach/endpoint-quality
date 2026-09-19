/**
 * The code-scan and performance repositories against a real Postgres.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  CodeConnectorEntity,
  CodeScanEntity,
  PerformancePlanEntity,
  PerformanceRunEntity,
} from "@/shared/database/entities";
import {
  TypeOrmCodeConnectorRepository,
  TypeOrmCodeScanRepository,
} from "@/modules/code-scan/infrastructure/persistence/typeorm-code-scan.repository";
import {
  TypeOrmPerformancePlanRepository,
  TypeOrmPerformanceRunRepository,
} from "@/modules/performance/infrastructure/persistence/typeorm-performance.repository";
import type { CodeConnector, CodeScan } from "@/modules/code-scan/domain/model";
import type { PerformancePlanRow, PerformanceRun } from "@/modules/performance/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

describe("TypeOrmCodeConnectorRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmCodeConnectorRepository;

  const connector = (projectId: string, fields: Partial<CodeConnector> = {}): CodeConnector =>
    ({
      id: randomUUID(),
      projectId,
      provider: "github",
      repo: "acme/api",
      branch: "main",
      basePath: "src",
      prefix: "/api",
      tokenCiphertext: null,
      createdAt: at(0),
      updatedAt: at(0),
      updatedBy: tenant.userId,
      ...fields,
    }) as CodeConnector;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmCodeConnectorRepository(db.dataSource.getRepository(CodeConnectorEntity));
  });
  after(async () => db?.drop());

  test("find returns null before a connector exists and the saved one after", async () => {
    assert.equal(await repo.find(tenant.projectId), null);
    const saved = connector(tenant.projectId, { tokenCiphertext: "v1.cipher" });
    await repo.save(saved);
    const found = await repo.find(tenant.projectId);
    assert.deepEqual(found, saved);
    assert.equal(await repo.find(tenant.otherProjectId), null, "another project sees nothing");
  });

  test("save updates the connector in place; a second id for the same project is refused", async () => {
    const t = await seedTenant(db.dataSource);
    const saved = connector(t.projectId);
    await repo.save(saved);
    await repo.save({ ...saved, branch: "develop", updatedAt: at(5) });
    assert.equal((await repo.find(t.projectId))?.branch, "develop");
    await assert.rejects(() => repo.save(connector(t.projectId)), /duplicate key/);
  });

  test("delete removes only that project's connector", async () => {
    const t = await seedTenant(db.dataSource);
    await repo.save(connector(t.projectId));
    await repo.save(connector(t.otherProjectId));
    await repo.delete(t.projectId);
    assert.equal(await repo.find(t.projectId), null);
    assert.ok(await repo.find(t.otherProjectId));
  });
});

describe("TypeOrmCodeScanRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmCodeScanRepository;

  const scan = (projectId: string, fields: Partial<CodeScan> = {}): CodeScan =>
    ({
      id: randomUUID(),
      projectId,
      source: "github",
      ref: "main",
      status: "done",
      result: { routes: [{ method: "GET", path: "/x" }] },
      diff: { added: [], removed: [] },
      impact: { endpoints: [] },
      error: null,
      createdAt: at(0),
      createdBy: tenant.userId,
      ...fields,
    }) as unknown as CodeScan;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmCodeScanRepository(db.dataSource.getRepository(CodeScanEntity));
  });
  after(async () => db?.drop());

  test("round-trips a scan with its jsonb documents and a null error", async () => {
    const saved = scan(tenant.projectId);
    await repo.save(saved);
    assert.deepEqual(await repo.find(tenant.projectId, saved.id), saved);
    const failed = scan(tenant.projectId, { status: "failed", error: "boom" } as unknown as Partial<CodeScan>);
    await repo.save(failed);
    assert.equal((await repo.find(tenant.projectId, failed.id))?.error, "boom");
  });

  test("find is scoped to the project and returns null for an unknown id", async () => {
    const saved = scan(tenant.projectId);
    await repo.save(saved);
    assert.equal(await repo.find(tenant.otherProjectId, saved.id), null);
    assert.equal(await repo.find(tenant.projectId, randomUUID()), null);
  });

  test("list is newest first and only of that project", async () => {
    const t = await seedTenant(db.dataSource);
    const old = scan(t.projectId, { createdAt: at(1) });
    const recent = scan(t.projectId, { createdAt: at(9) });
    const foreign = scan(t.otherProjectId, { createdAt: at(5) });
    for (const s of [old, foreign, recent]) await repo.save(s);
    assert.deepEqual(
      (await repo.list(t.projectId)).map((s) => s.id),
      [recent.id, old.id],
    );
  });

  test("delete needs the right project, and a deleted project takes its scans", async () => {
    const t = await seedTenant(db.dataSource);
    const saved = scan(t.projectId);
    await repo.save(saved);
    await repo.delete(t.otherProjectId, saved.id);
    assert.ok(await repo.find(t.projectId, saved.id), "another project cannot delete it");
    await repo.delete(t.projectId, saved.id);
    assert.equal(await repo.find(t.projectId, saved.id), null);

    const kept = scan(t.projectId);
    await repo.save(kept);
    await deleteProject(db.dataSource, t.projectId);
    assert.equal(await countRows(db.dataSource, "code_scans", `"projectId" = $1`, [t.projectId]), 0);
  });
});

describe("TypeOrmPerformancePlanRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmPerformancePlanRepository;

  const plan = (projectId: string, fields: Partial<PerformancePlanRow> = {}): PerformancePlanRow =>
    ({
      id: randomUUID(),
      projectId,
      name: "smoke",
      description: null,
      definition: { scenarios: [], profile: { type: "constant", vus: 2, durationS: 10 }, thresholds: {} },
      createdAt: at(0),
      updatedAt: at(0),
      updatedBy: tenant.userId,
      ...fields,
    }) as unknown as PerformancePlanRow;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmPerformancePlanRepository(db.dataSource.getRepository(PerformancePlanEntity));
  });
  after(async () => db?.drop());

  test("round-trips a plan, null description included, and finds it by id or by name", async () => {
    const saved = plan(tenant.projectId, { name: "load" });
    await repo.save(saved);
    assert.deepEqual(await repo.find(tenant.projectId, saved.id), saved);
    assert.deepEqual(await repo.findByName(tenant.projectId, "load"), saved);
    assert.equal(await repo.findByName(tenant.projectId, "nope"), null);
    assert.equal(await repo.findByName(tenant.otherProjectId, "load"), null);
    assert.equal(await repo.find(tenant.otherProjectId, saved.id), null);
    assert.equal(await repo.find(tenant.projectId, randomUUID()), null);
  });

  test("list is by name and scoped; delete needs the right project", async () => {
    const t = await seedTenant(db.dataSource);
    const b = plan(t.projectId, { name: "b" });
    const a = plan(t.projectId, { name: "a", description: "first" });
    const foreign = plan(t.otherProjectId, { name: "0" });
    for (const p of [b, foreign, a]) await repo.save(p);
    const listed = await repo.list(t.projectId);
    assert.deepEqual(
      listed.map((p) => p.name),
      ["a", "b"],
    );
    assert.equal(listed[0].description, "first");

    await repo.delete(t.otherProjectId, a.id);
    assert.ok(await repo.find(t.projectId, a.id));
    await repo.delete(t.projectId, a.id);
    assert.equal(await repo.find(t.projectId, a.id), null);
  });
});

describe("TypeOrmPerformanceRunRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmPerformanceRunRepository;

  const run = (projectId: string, fields: Partial<PerformanceRun> = {}): PerformanceRun =>
    ({
      id: randomUUID(),
      projectId,
      planId: null,
      planName: "",
      environmentId: null,
      status: "passed",
      definition: { scenarios: [] },
      progress: { done: 1 },
      summary: null,
      windows: [{ t: 0, rps: 3 }],
      endpoints: [],
      thresholds: [{ ok: true }],
      startedAt: at(0),
      finishedAt: null,
      error: null,
      ...fields,
    }) as unknown as PerformanceRun;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmPerformanceRunRepository(db.dataSource.getRepository(PerformanceRunEntity));
  });
  after(async () => db?.drop());

  test("round-trips a run with its snapshots and nulls, by project and by bare id", async () => {
    const saved = run(tenant.projectId, { summary: { p95: 12 }, finishedAt: at(3) } as unknown as Partial<PerformanceRun>);
    await repo.save(saved);
    assert.deepEqual(await repo.find(tenant.projectId, saved.id), saved);
    assert.deepEqual(await repo.findById(saved.id), saved);
    assert.equal(await repo.find(tenant.otherProjectId, saved.id), null);
    assert.equal(await repo.findById(randomUUID()), null);
  });

  test("list is newest first, filtered by plan when one is given", async () => {
    const t = await seedTenant(db.dataSource);
    const planA = randomUUID();
    const planB = randomUUID();
    const a1 = run(t.projectId, { planId: planA, startedAt: at(1) } as Partial<PerformanceRun>);
    const a2 = run(t.projectId, { planId: planA, startedAt: at(3) } as Partial<PerformanceRun>);
    const b1 = run(t.projectId, { planId: planB, startedAt: at(2) } as Partial<PerformanceRun>);
    const adhoc = run(t.projectId, { startedAt: at(4) });
    const foreign = run(t.otherProjectId, { planId: planA, startedAt: at(5) } as Partial<PerformanceRun>);
    for (const r of [a1, b1, foreign, adhoc, a2]) await repo.save(r);

    assert.deepEqual(
      (await repo.list(t.projectId)).map((r) => r.id),
      [adhoc.id, a2.id, b1.id, a1.id],
    );
    assert.deepEqual(
      (await repo.list(t.projectId, planA)).map((r) => r.id),
      [a2.id, a1.id],
    );
    assert.deepEqual(
      (await repo.list(t.projectId, "")).map((r) => r.id),
      [adhoc.id, a2.id, b1.id, a1.id],
      "an empty plan id is no filter",
    );
  });

  test("save updates the run; delete needs the right project", async () => {
    const saved = run(tenant.projectId, { status: "running" } as Partial<PerformanceRun>);
    await repo.save(saved);
    await repo.save({ ...saved, status: "failed", error: "timeout" } as PerformanceRun);
    const found = await repo.findById(saved.id);
    assert.equal(found?.status, "failed");
    assert.equal(found?.error, "timeout");

    await repo.delete(tenant.otherProjectId, saved.id);
    assert.ok(await repo.findById(saved.id));
    await repo.delete(tenant.projectId, saved.id);
    assert.equal(await repo.findById(saved.id), null);
  });
});
