/**
 * The runs adapters against a real Postgres (an isolated schema): cases and steps in order, totals
 * counted from the rows, the retention sweeps and what they must never touch, and the webhook waits
 * whose two racing writes are single statements.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { FlowHookEntity, RunCaseEntity, RunEntity, RunStepEntity } from "@/shared/database/entities";
import { TypeOrmRunRepository } from "@/modules/runs/infrastructure/persistence/typeorm-run.repository";
import { TypeOrmFlowHookRepository } from "@/modules/runs/infrastructure/persistence/typeorm-flow-hook.repository";
import type { CaseStatus, Run, RunCase, RunStep } from "@/modules/runs/domain/model";
import type { FlowHook, FlowHookDelivery } from "@/modules/runs/domain/flow-hooks";
import { dbSkip, openIsolatedDb, type IsolatedDb } from "@test/support/isolated-db";
import { countRows, insertProject, insertRun, insertRunCase } from "@test/support/repos-seed";

const at = (iso: string) => new Date(iso);

const makeRepo = (db: IsolatedDb) =>
  new TypeOrmRunRepository(
    db.dataSource.getRepository(RunEntity),
    db.dataSource.getRepository(RunCaseEntity),
    db.dataSource.getRepository(RunStepEntity),
  );
const run = (projectId: string, overrides: Partial<Run> = {}): Run => ({
  id: randomUUID(),
  projectId,
  environmentId: null,
  specVersionId: null,
  status: "queued",
  plan: { order: "contract", operationIds: [], samples: 1 } as never,
  totals: { cases: 0, completed: 0, passed: 0, failed: 0, skipped: 0 },
  triggeredByKind: "user",
  triggeredBy: randomUUID(),
  startedAt: at("2026-01-01T00:00:00Z"),
  finishedAt: null,
  error: null,
  ...overrides,
});
const runCase = (runId: string, position: number, overrides: Partial<RunCase> = {}): RunCase => ({
  id: randomUUID(),
  runId,
  failure: null,
  operationId: `op${position}`,
  scenarioId: "happy",
  method: "GET",
  path: "/x",
  status: "queued",
  position,
  durationMs: null,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});
const step = (runCaseId: string, index: number, overrides: Partial<RunStep> = {}): RunStep => ({
  id: randomUUID(),
  runCaseId,
  index,
  purpose: "main",
  label: `step ${index}`,
  request: { method: "GET", url: "http://x/y", headers: {}, body: null },
  expected: { status: 200, shape: "object", operationPath: "/y" },
  actual: { status: 200, contentType: "application/json", headers: {}, body: { ok: true } },
  assertions: [],
  latency: { samples: [12], budgetMs: null },
  ok: true,
  durationMs: 12,
  prunedAt: null,
  ...overrides,
});

describe("TypeOrmRunRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());
  const repo = () => makeRepo(db);

  test("save/findById round-trip; unknown is null", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const r = run(pid, { error: "boom", finishedAt: at("2026-01-01T00:01:00Z"), status: "error" });
    await repo().save(r);
    assert.deepEqual(await repo().findById(r.id), r);
    assert.equal(await repo().findById(randomUUID()), null);
  });

  test("listForProject: newest first, capped by the limit, and only that project's", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const { id: other } = await insertProject(db.dataSource);
    const days = ["2026-01-01", "2026-01-03", "2026-01-02"];
    for (const day of days) await repo().save(run(pid, { startedAt: at(`${day}T00:00:00Z`) }));
    await repo().save(run(other, { startedAt: at("2026-02-01T00:00:00Z") }));
    const listed = await repo().listForProject(pid, 2);
    assert.deepEqual(
      listed.map((r) => r.startedAt.toISOString()),
      ["2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
    );
    assert.equal((await repo().listForProject(pid, 10)).length, 3);
  });

  test("cases: saveCases([]) writes nothing; listed by position; findCase and saveCase", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const r = run(pid);
    await repo().save(r);
    await repo().saveCases([]);
    assert.deepEqual(await repo().listCases(r.id), []);

    const second = runCase(r.id, 1);
    const first = runCase(r.id, 0, { failure: "server" as never, status: "failed", durationMs: 30 });
    await repo().saveCases([second, first]);
    assert.deepEqual(await repo().listCases(r.id), [first, second]);

    await repo().saveCase({ ...second, status: "passed", durationMs: 5, finishedAt: at("2026-01-01T00:00:05Z") });
    const found = await repo().findCase(second.id);
    assert.equal(found?.status, "passed");
    assert.equal(found?.failure, null);
    assert.deepEqual(found?.finishedAt, at("2026-01-01T00:00:05Z"));
    assert.equal(await repo().findCase(randomUUID()), null);
  });

  test("saveCases chunks a large matrix and keeps every row", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const r = run(pid);
    await repo().save(r);
    await repo().saveCases(Array.from({ length: 250 }, (_, i) => runCase(r.id, i)));
    const listed = await repo().listCases(r.id);
    assert.equal(listed.length, 250);
    assert.deepEqual(
      listed.slice(0, 3).map((c) => c.position),
      [0, 1, 2],
    );
  });

  test("steps: saveSteps([]) is a no-op; listSteps by index with jsonb nulls defaulted; deleteSteps", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const runId = await insertRun(db.dataSource, pid);
    const caseId = await insertRunCase(db.dataSource, runId);
    await repo().saveSteps([]);
    const s1 = step(caseId, 1, { request: null, expected: null, actual: null, latency: null, ok: false });
    const s0 = step(caseId, 0);
    await repo().saveSteps([s1, s0]);

    const listed = await repo().listSteps(caseId);
    assert.deepEqual(listed, [s0, s1]);
    assert.equal(listed[1].latency, null);

    await repo().deleteSteps(caseId);
    assert.deepEqual(await repo().listSteps(caseId), []);
  });

  test("listStepsForRun orders by case position then step index, and skips other runs", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const runId = await insertRun(db.dataSource, pid);
    const otherRun = await insertRun(db.dataSource, pid);
    const late = await insertRunCase(db.dataSource, runId, { position: 2 });
    const early = await insertRunCase(db.dataSource, runId, { position: 1 });
    const foreign = await insertRunCase(db.dataSource, otherRun, { position: 0 });
    await repo().saveSteps([step(late, 0, { label: "late-0" }), step(early, 1, { label: "early-1" })]);
    await repo().saveSteps([step(early, 0, { label: "early-0" }), step(foreign, 0, { label: "foreign" })]);

    assert.deepEqual(
      (await repo().listStepsForRun(runId)).map((s) => s.label),
      ["early-0", "early-1", "late-0"],
    );
  });

  test("recomputeTotals counts from the rows and stores them; an empty run is all zeros", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const r = run(pid);
    await repo().save(r);
    const statuses: CaseStatus[] = ["passed", "passed", "failed", "skipped", "running", "queued"];
    await repo().saveCases(statuses.map((status, i) => runCase(r.id, i, { status })));

    const expected = { cases: 6, passed: 2, failed: 1, skipped: 1, completed: 4 };
    assert.deepEqual(await repo().recomputeTotals(r.id), expected);
    assert.deepEqual((await repo().findById(r.id))?.totals, expected);

    const empty = run(pid);
    await repo().save(empty);
    assert.deepEqual(await repo().recomputeTotals(empty.id), { cases: 0, passed: 0, failed: 0, skipped: 0, completed: 0 });
  });

  test("updateStatus stamps finishedAt only when finished, and the error only when given", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const r = run(pid);
    await repo().save(r);

    await repo().updateStatus(r.id, "running", at("2026-01-01T00:00:01Z"));
    let found = await repo().findById(r.id);
    assert.equal(found?.status, "running");
    assert.equal(found?.finishedAt, null);
    assert.equal(found?.error, null);

    await repo().updateStatus(r.id, "error", at("2026-01-01T00:00:02Z"), "target unreachable");
    found = await repo().findById(r.id);
    assert.equal(found?.status, "error");
    assert.deepEqual(found?.finishedAt, at("2026-01-01T00:00:02Z"));
    assert.equal(found?.error, "target unreachable");

    for (const status of ["passed", "failed", "cancelled"] as const) {
      const other = run(pid);
      await repo().save(other);
      await repo().updateStatus(other.id, status, at("2026-01-01T00:00:03Z"));
      assert.deepEqual((await repo().findById(other.id))?.finishedAt, at("2026-01-01T00:00:03Z"), status);
    }
  });

  describe("retention sweeps (a schema of their own, so the counts are exact)", () => {
    let own: IsolatedDb;
    before(async () => {
      own = await openIsolatedDb();
    });
    after(async () => own?.drop());

    async function seed(finishedAt: Date | null) {
      const { id: pid } = await insertProject(own.dataSource);
      const runId = await insertRun(own.dataSource, pid, { finishedAt, status: finishedAt ? "passed" : "running" });
      const caseId = await insertRunCase(own.dataSource, runId);
      const s = step(caseId, 0);
      await makeRepo(own).saveSteps([s]);
      return { runId, caseId, stepId: s.id };
    }

    test("pruneStepBodies empties old finished runs once, never a running or recent one", async () => {
      const cutoff = at("2026-06-01T00:00:00Z");
      const old = await seed(at("2026-01-01T00:00:00Z"));
      const recent = await seed(at("2026-07-01T00:00:00Z"));
      const running = await seed(null);
      const repo = makeRepo(own);

      assert.equal(await repo.pruneStepBodies(cutoff), 1);
      const [pruned] = await repo.listSteps(old.caseId);
      assert.equal(pruned.request, null);
      assert.equal(pruned.expected, null);
      assert.equal(pruned.actual, null);
      assert.ok(pruned.prunedAt instanceof Date);
      assert.deepEqual(pruned.assertions, []); // the verdict outlives the payload
      assert.equal(pruned.ok, true);
      for (const kept of [recent, running]) assert.notEqual((await repo.listSteps(kept.caseId))[0].request, null);

      assert.equal(await repo.pruneStepBodies(cutoff), 0, "a second pass has nothing to do");
    });

    test("deleteRunsBefore removes old finished runs with their cases and steps", async () => {
      const cutoff = at("2026-06-01T00:00:00Z");
      const repo = makeRepo(own);
      const initial = await countRows(own.dataSource, "runs");
      const old = await seed(at("2026-02-01T00:00:00Z"));
      const running = await seed(null);

      // The previous test left one old run behind too.
      assert.equal(await repo.deleteRunsBefore(cutoff), 2);
      assert.equal(await repo.findById(old.runId), null);
      assert.equal(await countRows(own.dataSource, "run_cases", `"id" = $1`, [old.caseId]), 0);
      assert.equal(await countRows(own.dataSource, "run_steps", `"id" = $1`, [old.stepId]), 0);
      assert.notEqual(await repo.findById(running.runId), null);
      assert.equal(await countRows(own.dataSource, "runs"), initial, "two added, two removed");
      assert.equal(await repo.deleteRunsBefore(cutoff), 0);
    });
  });
});

describe("TypeOrmFlowHookRepository", { skip: dbSkip }, () => {
  let db: IsolatedDb;
  before(async () => {
    db = await openIsolatedDb();
  });
  after(async () => db?.drop());
  const repo = () => new TypeOrmFlowHookRepository(db.dataSource.getRepository(FlowHookEntity));
  const now = at("2026-03-01T12:00:00Z");
  const hook = (runId: string, overrides: Partial<FlowHook> = {}): FlowHook => ({
    id: randomUUID(),
    tokenHash: randomUUID().replace(/-/g, ""),
    runId,
    caseId: randomUUID(),
    stepId: "wait-for-callback",
    method: "POST",
    status: "open",
    expiresAt: at("2026-03-01T13:00:00Z"),
    delivery: null,
    createdAt: at("2026-03-01T11:00:00Z"),
    ...overrides,
  });
  const delivery: FlowHookDelivery = {
    method: "POST",
    contentType: "application/json",
    headers: { "x-signature": "[masked]" },
    body: { paid: true },
    raw: '{"paid":true}',
    receivedAt: "2026-03-01T12:00:00.000Z",
  };
  async function aRun() {
    const { id: pid } = await insertProject(db.dataSource);
    return insertRun(db.dataSource, pid);
  }

  test("open/find round-trip; unknown is null", async () => {
    const h = hook(await aRun());
    await repo().open(h);
    assert.deepEqual(await repo().find(h.id), h);
    assert.equal(await repo().find(randomUUID()), null);
  });

  test("deliver takes an open, unexpired hook once and only with its method", async () => {
    const h = hook(await aRun());
    await repo().open(h);

    assert.equal(await repo().deliver(h.tokenHash, "PUT", delivery, now), null, "wrong method");
    assert.equal(await repo().deliver("nope", "POST", delivery, now), null, "unknown token");

    const delivered = await repo().deliver(h.tokenHash, "POST", delivery, now);
    assert.deepEqual(delivered, { ...h, status: "delivered", delivery });
    assert.ok(delivered?.expiresAt instanceof Date);

    assert.equal(await repo().deliver(h.tokenHash, "POST", delivery, now), null, "already delivered");
  });

  test("deliver refuses an expired hook", async () => {
    const h = hook(await aRun(), { expiresAt: at("2026-03-01T11:59:59Z") });
    await repo().open(h);
    assert.equal(await repo().deliver(h.tokenHash, "POST", delivery, now), null);
    assert.equal((await repo().find(h.id))?.status, "open");
  });

  test("settle returns what was delivered and wipes it; an open hook is closed with nothing", async () => {
    const runId = await aRun();
    const delivered = hook(runId);
    const waiting = hook(runId);
    await repo().open(delivered);
    await repo().open(waiting);
    await repo().deliver(delivered.tokenHash, "POST", delivery, now);

    assert.deepEqual(await repo().settle(delivered.id), delivery);
    const settled = await repo().find(delivered.id);
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.delivery, null);

    assert.equal(await repo().settle(waiting.id), null);
    assert.equal((await repo().find(waiting.id))?.status, "closed");
    // A late call finds it closed.
    assert.equal(await repo().deliver(waiting.tokenHash, "POST", delivery, now), null);

    assert.equal(await repo().settle(randomUUID()), null, "unknown id");
  });

  test("openForRun lists the run's open, unexpired waits, oldest first", async () => {
    const runId = await aRun();
    const otherRun = await aRun();
    const second = hook(runId, { stepId: "second", createdAt: at("2026-03-01T11:30:00Z") });
    const first = hook(runId, { stepId: "first", createdAt: at("2026-03-01T11:00:00Z") });
    const expired = hook(runId, { stepId: "expired", expiresAt: at("2026-03-01T11:00:00Z") });
    const closed = hook(runId, { stepId: "closed", status: "closed" });
    for (const h of [second, first, expired, closed, hook(otherRun, { stepId: "foreign" })]) await repo().open(h);

    assert.deepEqual(
      (await repo().openForRun(runId, now)).map((h) => h.stepId),
      ["first", "second"],
    );
  });

  test("the waits go with their run (cascade)", async () => {
    const { id: pid } = await insertProject(db.dataSource);
    const runId = await insertRun(db.dataSource, pid);
    const h = hook(runId);
    await repo().open(h);
    await db.dataSource.query(`DELETE FROM "runs" WHERE "id" = $1`, [runId]);
    assert.equal(await repo().find(h.id), null);
  });
});
