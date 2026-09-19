/**
 * The security-runs and project-config adapters against a real Postgres (an isolated schema):
 * history order and limit, the share token as the only public handle, and config sections keyed by
 * project and name.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { ProjectConfigEntity, SecurityRunEntity } from "@/shared/database/entities";
import { TypeOrmSecurityRunRepository } from "@/modules/security-runs/infrastructure/persistence/typeorm-security-run.repository";
import { TypeOrmConfigRepository } from "@/modules/config/infrastructure/persistence/typeorm-config.repository";
import type { SecurityRun } from "@/modules/security-runs/domain/model";
import type { ConfigRow } from "@/modules/config/domain/ports";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";
import { insertProject } from "@test/support/repos-seed";

const at = (iso: string) => new Date(iso);

describe("security-runs and config persistence adapters", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());

  describe("TypeOrmSecurityRunRepository", () => {
    const repo = () => new TypeOrmSecurityRunRepository(db.dataSource.getRepository(SecurityRunEntity));
    const securityRun = (projectId: string, overrides: Partial<SecurityRun> = {}): SecurityRun =>
      ({
        id: randomUUID(),
        projectId,
        environmentId: randomUUID(),
        label: "nightly",
        status: "passed",
        rules: { cors: true, headers: false },
        options: { maxRequests: 50 },
        progress: { done: 3, total: 3 },
        score: 87,
        risk: "low",
        summary: { high: 0, medium: 1 },
        findings: [{ id: "f1", severity: "medium" }],
        probes: [{ id: "p1" }],
        ai: null,
        visibility: "private",
        shareToken: null,
        triggeredByKind: "user",
        triggeredBy: randomUUID(),
        startedAt: at("2026-01-01T00:00:00Z"),
        finishedAt: at("2026-01-01T00:05:00Z"),
        error: null,
        ...overrides,
      }) as unknown as SecurityRun;

    test("save/findById round-trip with every jsonb column; unknown is null", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const r = securityRun(pid);
      await repo().save(r);
      assert.deepEqual(await repo().findById(r.id), r);
      assert.equal(await repo().findById(randomUUID()), null);
    });

    test("columns left out take their defaults", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const id = randomUUID();
      await repo().save({
        id,
        projectId: pid,
        environmentId: randomUUID(),
        status: "queued",
        triggeredByKind: "api-token",
        triggeredBy: randomUUID(),
        startedAt: new Date(),
      } as unknown as SecurityRun);
      const found = await repo().findById(id);
      assert.equal(found?.label, "");
      assert.equal(found?.visibility, "private");
      assert.deepEqual(found?.rules, {});
      assert.deepEqual(found?.findings, []);
      assert.deepEqual(found?.probes, []);
      assert.equal(found?.score, null);
      assert.equal(found?.shareToken, null);
    });

    test("findByShareToken finds only a shared run; share tokens are unique", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const token = randomUUID();
      const shared = securityRun(pid, { visibility: "public", shareToken: token });
      await repo().save(shared);
      await repo().save(securityRun(pid)); // null token: many may be null
      await repo().save(securityRun(pid));
      assert.equal((await repo().findByShareToken(token))?.id, shared.id);
      assert.equal(await repo().findByShareToken(randomUUID()), null);
      await assert.rejects(repo().save(securityRun(pid, { shareToken: token })), /duplicate|unique/i);
    });

    test("listForProject: newest first, limited, only that project's; remove deletes one", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const a = securityRun(pid, { label: "a", startedAt: at("2026-01-01T00:00:00Z") });
      const b = securityRun(pid, { label: "b", startedAt: at("2026-01-03T00:00:00Z") });
      const c = securityRun(pid, { label: "c", startedAt: at("2026-01-02T00:00:00Z") });
      for (const r of [a, b, c, securityRun(other, { label: "x" })]) await repo().save(r);

      assert.deepEqual(
        (await repo().listForProject(pid, 2)).map((r) => r.label),
        ["b", "c"],
      );
      await repo().remove(b.id);
      assert.equal(await repo().findById(b.id), null);
      assert.deepEqual(
        (await repo().listForProject(pid, 10)).map((r) => r.label),
        ["c", "a"],
      );
      assert.equal((await repo().listForProject(other, 10)).length, 1);
    });
  });

  describe("TypeOrmConfigRepository", () => {
    const repo = () => new TypeOrmConfigRepository(db.dataSource.getRepository(ProjectConfigEntity));
    const row = (projectId: string, section: ConfigRow["section"], data: unknown): ConfigRow => ({
      projectId,
      section,
      data,
      updatedAt: at("2026-01-01T00:00:00Z"),
      updatedBy: randomUUID(),
    });

    test("listSections is ordered by section name and scoped to the project", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      const scenarios = row(pid, "scenarios", { s: 1 });
      const bodies = row(pid, "bodies", { bodyTemplates: {} });
      const parameters = row(pid, "parameters", { p: [1, 2] });
      for (const r of [scenarios, bodies, parameters, row(other, "access", {})]) await repo().saveSection(r);
      assert.deepEqual(await repo().listSections(pid), [bodies, parameters, scenarios]);
    });

    test("findSection by project and name; saveSection of the same key replaces it", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      await repo().saveSection(row(pid, "bodies", { v: 1 }));
      const replacement = { ...row(pid, "bodies", { v: 2 }), updatedAt: at("2026-02-01T00:00:00Z") };
      await repo().saveSection(replacement);
      assert.deepEqual(await repo().findSection(pid, "bodies"), replacement);
      assert.equal(await repo().findSection(pid, "scenarios"), null);
      assert.equal(await repo().findSection(other, "bodies"), null);
    });

    test("deleteSection removes that section only", async () => {
      const { id: pid } = await insertProject(db.dataSource);
      const { id: other } = await insertProject(db.dataSource);
      await repo().saveSection(row(pid, "bodies", {}));
      await repo().saveSection(row(pid, "scenarios", {}));
      await repo().saveSection(row(other, "bodies", {}));
      await repo().deleteSection(pid, "bodies");
      assert.deepEqual(
        (await repo().listSections(pid)).map((r) => r.section),
        ["scenarios"],
      );
      assert.notEqual(await repo().findSection(other, "bodies"), null);
    });

    test("a section for a project that does not exist violates the foreign key", async () => {
      await assert.rejects(repo().saveSection(row(randomUUID(), "bodies", {})), /foreign key/i);
    });
  });
});
