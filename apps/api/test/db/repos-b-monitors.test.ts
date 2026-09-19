/**
 * The monitor repository against a real Postgres: the monitors, the claim of the due ones under
 * `FOR UPDATE SKIP LOCKED`, and the execution history with its trimming.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { MonitorEntity, MonitorExecutionEntity } from "@/shared/database/entities";
import { TypeOrmMonitorRepository } from "@/modules/monitors/infrastructure/persistence/typeorm-monitor.repository";
import type { Monitor, MonitorExecution } from "@/modules/monitors/domain/model";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "../support/isolated-db";
import { at, plain, countRows, deleteProject, seedTenant, type Tenant } from "../support/repos-seed-b";

describe("TypeOrmMonitorRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  let tenant: Tenant;
  let repo: TypeOrmMonitorRepository;

  const monitor = (projectId: string, fields: Record<string, unknown> = {}): Monitor =>
    ({
      id: randomUUID(),
      projectId,
      name: "nightly",
      enabled: true,
      schedule: { kind: "interval", minutes: 5 },
      plan: { kind: "workflow", workflowId: "w" },
      alert: null,
      nextRunAt: null,
      lastRunAt: null,
      lastOutcome: null,
      consecutiveFailures: 0,
      createdAt: at(0),
      updatedAt: at(0),
      createdBy: tenant.userId,
      ...fields,
    }) as unknown as Monitor;

  const execution = (monitorId: string, fields: Record<string, unknown> = {}): MonitorExecution =>
    ({
      id: randomUUID(),
      monitorId,
      projectId: tenant.projectId,
      runId: null,
      outcome: "passed",
      startedAt: at(0),
      finishedAt: null,
      totals: null,
      note: "",
      ...fields,
    }) as unknown as MonitorExecution;

  before(async () => {
    db = await openIsolatedDb();
    tenant = await seedTenant(db.dataSource);
    repo = new TypeOrmMonitorRepository(
      db.dataSource.getRepository(MonitorEntity),
      db.dataSource.getRepository(MonitorExecutionEntity),
      db.dataSource,
    );
  });
  after(async () => db?.drop());

  describe("monitors", () => {
    test("round-trips a monitor with its jsonb and nullable columns", async () => {
      const saved = monitor(tenant.projectId, {
        alert: { email: ["a@b.c"] },
        nextRunAt: at(60),
        lastRunAt: at(1),
        lastOutcome: "failed",
        consecutiveFailures: 2,
      });
      await repo.save(saved);
      assert.deepEqual(plain(await repo.findById(tenant.projectId, saved.id)), saved);

      const bare = monitor(tenant.projectId);
      await repo.save(bare);
      const found = await repo.findById(tenant.projectId, bare.id);
      assert.equal(found?.alert, null);
      assert.equal(found?.nextRunAt, null);
      assert.equal(found?.lastOutcome, null);
    });

    test("findById and remove are scoped to the project", async () => {
      const saved = monitor(tenant.projectId);
      await repo.save(saved);
      assert.equal(await repo.findById(tenant.otherProjectId, saved.id), null);
      assert.equal(await repo.findById(tenant.projectId, randomUUID()), null);
      assert.equal(await repo.remove(tenant.otherProjectId, saved.id), false);
      assert.ok(await repo.findById(tenant.projectId, saved.id));
      assert.equal(await repo.remove(tenant.projectId, saved.id), true);
      assert.equal(await repo.findById(tenant.projectId, saved.id), null);
      assert.equal(await repo.remove(tenant.projectId, saved.id), false, "a second remove finds nothing");
    });

    test("listByProject is oldest first and only that project's", async () => {
      const t = await seedTenant(db.dataSource);
      const late = monitor(t.projectId, { name: "late", createdAt: at(9) });
      const early = monitor(t.projectId, { name: "early", createdAt: at(1) });
      const foreign = monitor(t.otherProjectId, { name: "foreign" });
      for (const m of [late, foreign, early]) await repo.save(m);
      assert.deepEqual(
        (await repo.listByProject(t.projectId)).map((m) => m.name),
        ["early", "late"],
      );
    });
  });

  describe("claimDue", () => {
    // Global query: each test starts from a table with only its own monitors.
    beforeEach(async () => {
      await db.dataSource.query(`DELETE FROM monitors`);
    });

    test("claims the enabled, due monitors oldest turn first, and advances their turn", async () => {
      const dueOld = monitor(tenant.projectId, { name: "due-old", nextRunAt: at(10) });
      const dueNew = monitor(tenant.otherProjectId, { name: "due-new", nextRunAt: at(20) });
      const dueNow = monitor(tenant.projectId, { name: "due-now", nextRunAt: at(30) });
      const future = monitor(tenant.projectId, { name: "future", nextRunAt: at(31) });
      const disabled = monitor(tenant.projectId, { name: "disabled", enabled: false, nextRunAt: at(1) });
      const off = monitor(tenant.projectId, { name: "off", nextRunAt: null });
      for (const m of [future, dueNew, disabled, dueNow, off, dueOld]) await repo.save(m);

      const seen: string[] = [];
      const claimed = await repo.claimDue(at(30), 10, (m) => {
        seen.push(m.name);
        return m.name === "due-new" ? null : at(1000);
      });
      assert.deepEqual(
        claimed.map((m) => m.name),
        ["due-old", "due-new", "due-now"],
      );
      assert.deepEqual(seen, ["due-old", "due-new", "due-now"]);
      assert.equal(claimed[0].nextRunAt?.getTime(), at(1000).getTime(), "returned with the new turn");
      assert.equal(claimed[1].nextRunAt, null);

      assert.equal((await repo.findById(tenant.projectId, dueOld.id))?.nextRunAt?.getTime(), at(1000).getTime());
      assert.equal((await repo.findById(tenant.otherProjectId, dueNew.id))?.nextRunAt, null);
      assert.equal((await repo.findById(tenant.projectId, future.id))?.nextRunAt?.getTime(), at(31).getTime());
      assert.equal((await repo.findById(tenant.projectId, disabled.id))?.nextRunAt?.getTime(), at(1).getTime());

      assert.deepEqual(plain(await repo.claimDue(at(30), 10, () => at(2000))), [], "nothing is due twice");
    });

    test("respects the limit and leaves the rest due for the next tick", async () => {
      for (let i = 0; i < 3; i++) await repo.save(monitor(tenant.projectId, { name: `m${i}`, nextRunAt: at(i) }));
      const first = await repo.claimDue(at(10), 2, () => at(1000));
      assert.deepEqual(
        first.map((m) => m.name),
        ["m0", "m1"],
      );
      const second = await repo.claimDue(at(10), 2, () => at(1000));
      assert.deepEqual(
        second.map((m) => m.name),
        ["m2"],
      );
    });

    test("skips a monitor another transaction holds instead of waiting for it", async () => {
      const held = monitor(tenant.projectId, { name: "held", nextRunAt: at(1) });
      const free = monitor(tenant.projectId, { name: "free", nextRunAt: at(2) });
      await repo.save(held);
      await repo.save(free);

      const other = db.dataSource.createQueryRunner();
      await other.connect();
      await other.startTransaction();
      try {
        await other.query(`SELECT id FROM monitors WHERE id = $1 FOR UPDATE`, [held.id]);
        const claimed = await repo.claimDue(at(10), 10, () => at(1000));
        assert.deepEqual(
          claimed.map((m) => m.name),
          ["free"],
        );
      } finally {
        await other.rollbackTransaction();
        await other.release();
      }
      const later = await repo.claimDue(at(10), 10, () => at(1000));
      assert.deepEqual(
        later.map((m) => m.name),
        ["held"],
      );
    });

    test("a callback that throws rolls back every turn advanced in the claim", async () => {
      const a = monitor(tenant.projectId, { name: "a", nextRunAt: at(1) });
      const b = monitor(tenant.projectId, { name: "b", nextRunAt: at(2) });
      await repo.save(a);
      await repo.save(b);
      await assert.rejects(
        () =>
          repo.claimDue(at(10), 10, (m) => {
            if (m.name === "b") throw new Error("bad schedule");
            return at(1000);
          }),
        /bad schedule/,
      );
      assert.equal((await repo.findById(tenant.projectId, a.id))?.nextRunAt?.getTime(), at(1).getTime());
    });
  });

  describe("executions", () => {
    test("round-trips an execution and finds it by run", async () => {
      const m = monitor(tenant.projectId);
      await repo.save(m);
      const runId = randomUUID();
      const saved = execution(m.id, { runId, finishedAt: at(5), totals: { passed: 3 }, note: "ok" });
      await repo.saveExecution(saved);
      assert.deepEqual(plain(await repo.findExecutionByRun(runId)), saved);
      assert.equal(await repo.findExecutionByRun(randomUUID()), null);
    });

    test("listExecutions is newest first up to the limit, only that monitor's", async () => {
      const m = monitor(tenant.projectId);
      const other = monitor(tenant.projectId);
      await repo.save(m);
      await repo.save(other);
      const e1 = execution(m.id, { startedAt: at(1) });
      const e2 = execution(m.id, { startedAt: at(2) });
      const e3 = execution(m.id, { startedAt: at(3) });
      for (const e of [e2, e3, e1, execution(other.id, { startedAt: at(4) })]) await repo.saveExecution(e);
      assert.deepEqual(
        (await repo.listExecutions(m.id, 10)).map((e) => e.id),
        [e3.id, e2.id, e1.id],
      );
      assert.deepEqual(
        (await repo.listExecutions(m.id, 1)).map((e) => e.id),
        [e3.id],
      );
    });

    test("trimExecutions keeps the newest by start time, and does nothing under the cap", async () => {
      const m = monitor(tenant.projectId);
      const other = monitor(tenant.projectId);
      await repo.save(m);
      await repo.save(other);
      const executions = [5, 1, 4, 2, 3].map((s) => execution(m.id, { startedAt: at(s) }));
      for (const e of executions) await repo.saveExecution(e);
      await repo.saveExecution(execution(other.id, { startedAt: at(0) }));

      await repo.trimExecutions(m.id, 10);
      assert.equal((await repo.listExecutions(m.id, 100)).length, 5);

      await repo.trimExecutions(m.id, 2);
      assert.deepEqual(
        (await repo.listExecutions(m.id, 100)).map((e) => e.startedAt.getTime()),
        [at(5).getTime(), at(4).getTime()],
      );
      assert.equal((await repo.listExecutions(other.id, 100)).length, 1, "another monitor's history is untouched");
    });

    test("removing a monitor or its project takes its executions", async () => {
      const t = await seedTenant(db.dataSource);
      const m = monitor(t.projectId);
      await repo.save(m);
      await repo.saveExecution(execution(m.id, { projectId: t.projectId }));
      assert.equal(await repo.remove(t.projectId, m.id), true);
      assert.equal(await countRows(db.dataSource, "monitor_executions", `"monitorId" = $1`, [m.id]), 0);

      const kept = monitor(t.projectId);
      await repo.save(kept);
      await repo.saveExecution(execution(kept.id, { projectId: t.projectId }));
      await deleteProject(db.dataSource, t.projectId);
      assert.equal(await countRows(db.dataSource, "monitor_executions", `"projectId" = $1`, [t.projectId]), 0);
    });

    test("an execution of an unknown monitor violates the foreign key", async () => {
      await assert.rejects(() => repo.saveExecution(execution(randomUUID())), /foreign key/);
    });
  });
});
