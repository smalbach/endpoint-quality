/**
 * The run commands and queries, one handler at a time, over in-memory repositories.
 *
 * The http suites reach these through the controllers, where the DTO validation catches most of
 * what is interesting before the handler sees it. A monitor or a pipeline calls the command bus
 * directly, though, so the handler's own refusals are the ones that hold — and those are asserted
 * here by kind and code, the way the Problem Details filter will turn them into a status.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "@nestjs/common";

import { ConflictError, InvalidInputError, NotFoundError } from "@/shared/errors/domain-error";
import { StartRunCommand, StartRunHandler } from "@/modules/runs/application/commands/start-run";
import { CancelRunCommand, CancelRunHandler } from "@/modules/runs/application/commands/cancel-run";
import { ResumeRunCommand, ResumeRunHandler } from "@/modules/runs/application/commands/resume-run";
import { PreviewRequestCommand, PreviewRequestHandler } from "@/modules/runs/application/commands/preview-request";
import { PruneRunsCommand, PruneRunsHandler } from "@/modules/runs/application/commands/prune-runs";
import {
  GetRunCaseHandler,
  GetRunCaseQuery,
  GetRunReportHandler,
  GetRunReportQuery,
} from "@/modules/runs/application/queries/get-run";
import { describeSource, loadCatalog } from "@/modules/runs/application/queries/describe-source";
import { RetentionScheduler } from "@/modules/runs/infrastructure/retention.scheduler";
import type { Run, RunPlan } from "@/modules/runs/domain/model";
import type { Env } from "@/shared/config/env";
import { InMemoryRunQueue } from "@/modules/runs/infrastructure/queue/in-memory-queue";
import { InMemoryRunRepository, InMemoryWorkflowRepository } from "@test/support/in-memory-repositories";

Logger.overrideLogger(false);

const ORG = "org-1";
const now = new Date("2026-03-01T10:00:00.000Z");

type ProjectRow = { id: string; organizationId: string; activeSpecVersionId: string | null };

function projectsOf(...rows: ProjectRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { findById: async (id: string) => byId.get(id) ?? null } as never;
}

const environments = {
  findById: async (id: string) => (id === "env-1" ? { id: "env-1", projectId: "p1" } : null),
} as never;

const env = { MAX_RUN_CASES: 10 } as Env;
const clock = { now: () => now };

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  assert.fail("se esperaba un rechazo");
}

async function saveFlow(workflows: InMemoryWorkflowRepository, id: string, steps: unknown[]) {
  await workflows.saveWorkflow({
    id,
    projectId: "p1",
    name: id,
    description: null,
    status: "ready" as never,
    definition: { steps } as never,
    createdAt: now,
    updatedAt: now,
    updatedBy: "tester",
  });
}

async function saveSuite(workflows: InMemoryWorkflowRepository, id: string, workflowIds: string[]) {
  await workflows.saveSuite({
    id,
    projectId: "p1",
    name: `Suite ${id}`,
    description: null,
    workflowIds,
    createdAt: now,
    updatedAt: now,
    updatedBy: "tester",
  });
}

function starter(options: { spec?: string | null; channels?: unknown } = {}) {
  const workflows = new InMemoryWorkflowRepository();
  const runs = new InMemoryRunRepository();
  const enqueued: string[] = [];
  const handler = new StartRunHandler(
    projectsOf({ id: "p1", organizationId: ORG, activeSpecVersionId: options.spec === undefined ? "spec-1" : options.spec }),
    environments,
    workflows,
    runs,
    { enqueue: async (id: string) => void enqueued.push(id) } as never,
    clock,
    env,
    (options.channels ?? null) as never,
  );
  const start = (input: Partial<RunPlan>, org = ORG) =>
    handler.execute(
      new StartRunCommand(org, "p1", { environmentId: "env-1", ...input } as never, { kind: "monitor", id: "m-1" }),
    );
  return { workflows, runs, enqueued, start };
}

describe("lanzar una corrida", () => {
  test("un proyecto de otra organización es un 404", async () => {
    const { start } = starter();
    const error = await rejection(start({}, "otra-org"));
    assert.ok(error instanceof NotFoundError);
    assert.equal((error as NotFoundError).code, "project-not-found");
  });

  test("un conjunto de datos sin su flujo se rechaza nombrando el campo", async () => {
    const { start } = starter();
    const error = (await rejection(start({ datasetId: "d1" }))) as InvalidInputError;
    assert.ok(error instanceof InvalidInputError);
    assert.deepEqual(error.fields.map((field) => field.field), ["datasetId"]);
  });

  test("un plan cuyo número no es un número se rechaza antes de encolar", async () => {
    const { start, enqueued } = starter();
    const error = await rejection(start({ samples: Number.NaN }));
    assert.ok(error instanceof InvalidInputError);
    assert.equal(error.message, "Plan de ejecución inválido");
    assert.equal(enqueued.length, 0);
  });

  test("un canal junto a un flujo, un canal mal formado y un canal sin el módulo de canales", async () => {
    const { start, workflows } = starter({ spec: null });
    await saveFlow(workflows, "f1", [{ id: "a", kind: "fetch", fetch: { method: "GET", url: "/a" } }]);

    const both = (await rejection(start({ channel: { channelId: "c1" } as never, workflowId: "f1" }))) as InvalidInputError;
    assert.match(both.message, /un canal, un flujo o una suite, no varios/);

    const malformed = (await rejection(start({ channel: { channelId: 42 } as never }))) as InvalidInputError;
    assert.equal(malformed.code, "channel-invalid");
    assert.ok(malformed.fields.length > 0);
    assert.ok(malformed.fields.every((field) => field.field.startsWith("channel")), JSON.stringify(malformed.fields));

    const missing = (await rejection(
      start({ channel: { channelId: "7d0c5a3e-1f7b-4b54-9c1e-2f7c1b1a9e01" } as never }),
    )) as InvalidInputError;
    assert.equal(missing.code, "channel-not-found");
  });

  test("sin contrato, un flujo de fetch con sub-flujos en ciclo no lo necesita y se encola", async () => {
    const { start, workflows, runs, enqueued } = starter({ spec: null });
    await saveFlow(workflows, "a", [
      { id: "pide", kind: "fetch", fetch: { method: "GET", url: "/a" } },
      { id: "sub", kind: "subflow", subflow: { workflowId: "b" } },
    ]);
    await saveFlow(workflows, "b", [
      { id: "vuelve", kind: "subflow", subflow: { workflowId: "a" } },
      { id: "fantasma", kind: "subflow", subflow: { workflowId: "borrado" } },
    ]);
    const { runId } = await start({ workflowId: "a" });
    assert.deepEqual(enqueued, [runId]);
    const run = (await runs.findById(runId))!;
    assert.equal(run.specVersionId, null);
    assert.equal(run.triggeredByKind, "monitor");
    assert.equal(run.plan.concurrency, 1);
  });

  test("sin contrato, una suite que no existe no pide contrato y se rechaza por no existir", async () => {
    const { start } = starter({ spec: null });
    const error = (await rejection(start({ suiteId: "no-existe" }))) as InvalidInputError;
    assert.equal(error.code, "suite-not-found");
  });

  test("una suite con un flujo borrado cuenta cero pasos por él y se encola", async () => {
    const { start, workflows, runs } = starter();
    await saveFlow(workflows, "f1", [{ id: "a", kind: "fetch", fetch: { method: "GET", url: "/a" } }]);
    await saveSuite(workflows, "s1", ["f1", "borrado"]);
    const { runId } = await start({ suiteId: "s1", breakpoints: ["a", "a"], pauseMode: "breakpoints" });
    const run = (await runs.findById(runId))!;
    assert.equal(run.plan.suiteId, "s1");
    assert.deepEqual(run.plan.breakpoints, ["a"]);
  });

  test("un flujo que multiplicado por sus filas pasa del tope se rechaza con la cuenta", async () => {
    const { start, workflows } = starter();
    await saveFlow(
      workflows,
      "f1",
      Array.from({ length: 4 }, (_, index) => ({ id: `s${index}`, kind: "fetch", fetch: { method: "GET", url: "/a" } })),
    );
    await workflows.saveDataset({
      id: "d1",
      projectId: "p1",
      workflowId: "f1",
      name: "tres",
      rows: [{ a: "1" }, { a: "2" }, { a: "3" }],
      createdAt: now,
      updatedAt: now,
      updatedBy: "tester",
    });
    const error = (await rejection(start({ workflowId: "f1", datasetId: "d1" }))) as InvalidInputError;
    assert.equal(error.code, "run-too-large");
    assert.equal(error.message, "Esta corrida generaría 12 casos y el tope es 10");
    assert.deepEqual(error.fields, [{ field: "datasetId", detail: "4 pasos × 3 filas" }]);
  });
});

function runRow(id: string, projectId: string, plan: Partial<RunPlan> = {}, status: Run["status"] = "running"): Run {
  return {
    id,
    projectId,
    environmentId: "env-1",
    specVersionId: null,
    status,
    plan: { order: "safe" as never, customOrder: [], operationIds: [], caseSelection: {}, samples: 1, delayMs: 0, ...plan },
    totals: { cases: 0, completed: 0, passed: 0, failed: 0, skipped: 0 },
    triggeredByKind: "user",
    triggeredBy: "u",
    startedAt: now,
    finishedAt: null,
    error: null,
  };
}

describe("leer una corrida", () => {
  const projects = projectsOf({ id: "p1", organizationId: ORG, activeSpecVersionId: null });

  test("un caso de otra corrida, o una corrida de otro proyecto, son 404 distintos", async () => {
    const runs = new InMemoryRunRepository();
    await runs.save(runRow("r1", "p1"));
    await runs.save(runRow("r2", "p1"));
    await runs.save(runRow("ajena", "p2"));
    await runs.saveCase({
      id: "c-de-r2",
      runId: "r2",
      failure: null,
      operationId: "",
      scenarioId: "x",
      method: "GET",
      path: "/",
      status: "passed",
      position: 0,
      durationMs: 1,
      startedAt: now,
      finishedAt: now,
    });
    const handler = new GetRunCaseHandler(projects, runs);
    const wrongCase = (await rejection(handler.execute(new GetRunCaseQuery(ORG, "p1", "r1", "c-de-r2")))) as NotFoundError;
    assert.equal(wrongCase.code, "run-case-not-found");
    const foreign = (await rejection(handler.execute(new GetRunCaseQuery(ORG, "p1", "ajena", "c-de-r2")))) as NotFoundError;
    assert.equal(foreign.code, "run-not-found");

    const report = new GetRunReportHandler(projects, runs, new InMemoryWorkflowRepository());
    const missing = (await rejection(report.execute(new GetRunReportQuery(ORG, "p1", "ajena")))) as NotFoundError;
    assert.equal(missing.code, "run-not-found");
  });

  test("el informe deja vacío un caso sin pasos y unas aserciones que no son una lista", async () => {
    const runs = new InMemoryRunRepository();
    await runs.save(runRow("r1", "p1", { labels: undefined }));
    const base = {
      runId: "r1",
      failure: null,
      operationId: "",
      method: "GET",
      path: "/",
      status: "passed" as const,
      durationMs: 1,
      startedAt: now,
      finishedAt: now,
    };
    await runs.saveCases([
      { ...base, id: "vacio", scenarioId: "a", position: 0 },
      { ...base, id: "raro", scenarioId: "b", position: 1 },
    ]);
    await runs.saveSteps([
      {
        id: "s1",
        runCaseId: "raro",
        index: 0,
        purpose: "act",
        label: "GET /",
        request: null,
        expected: null,
        actual: null,
        assertions: { escrito: "por una versión vieja" } as never,
        latency: null,
        ok: true,
        durationMs: 1,
      },
    ]);
    const report = await new GetRunReportHandler(projects, runs, new InMemoryWorkflowRepository()).execute(
      new GetRunReportQuery(ORG, "p1", "r1"),
    );
    assert.deepEqual(report.cases.find((item) => item.id === "vacio")?.steps, []);
    assert.deepEqual(report.cases.find((item) => item.id === "raro")?.steps[0].assertions, []);
    // A matrix run written before labels existed reads as «no label filter».
    assert.deepEqual(report.run.source, { kind: "matrix", operationIds: [], labels: [] });
  });

  test("el origen nombra lo que existe y dice null de lo borrado", async () => {
    const workflows = new InMemoryWorkflowRepository();
    await saveFlow(workflows, "f1", []);
    await saveSuite(workflows, "s1", ["f1", "borrado"]);
    const channels = { listByProject: async () => [{ id: "c1", name: "Precios" }] } as never;
    const catalog = await loadCatalog(workflows, "p1", channels);
    const empty = await loadCatalog(workflows, "p1");

    assert.deepEqual(describeSource(runRow("r", "p1", { channel: { channelId: "c1" } as never }), catalog), {
      kind: "channel",
      channelId: "c1",
      name: "Precios",
    });
    assert.deepEqual(describeSource(runRow("r", "p1", { channel: { channelId: "c1" } as never }), empty), {
      kind: "channel",
      channelId: "c1",
      name: null,
    });
    assert.deepEqual(describeSource(runRow("r", "p1", { suiteId: "s1" }), catalog), {
      kind: "suite",
      suiteId: "s1",
      name: "Suite s1",
      flowNames: ["f1", null],
    });
    assert.deepEqual(describeSource(runRow("r", "p1", { suiteId: "borrada" }), catalog), {
      kind: "suite",
      suiteId: "borrada",
      name: null,
      flowNames: [],
    });
    assert.deepEqual(describeSource(runRow("r", "p1", { workflowId: "f1", datasetId: "borrado" }), catalog), {
      kind: "workflow",
      workflowId: "f1",
      name: "f1",
      datasetId: "borrado",
      datasetName: null,
      rows: 0,
    });
  });
});

describe("cancelar y reanudar", () => {
  const projects = projectsOf({ id: "p1", organizationId: ORG, activeSpecVersionId: null });

  test("una corrida de otro proyecto es un 404 y una terminada un 409, para las dos órdenes", async () => {
    const runs = new InMemoryRunRepository();
    await runs.save(runRow("ajena", "p2"));
    await runs.save(runRow("hecha", "p1", {}, "passed"));
    const queue = new InMemoryRunQueue();
    const cancel = new CancelRunHandler(projects, runs, queue);
    const resume = new ResumeRunHandler(projects, runs, queue);

    for (const attempt of [
      () => cancel.execute(new CancelRunCommand(ORG, "p1", "ajena")),
      () => resume.execute(new ResumeRunCommand(ORG, "p1", "ajena", "step")),
    ]) {
      const error = (await rejection(attempt())) as NotFoundError;
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.code, "run-not-found");
    }
    for (const attempt of [
      () => cancel.execute(new CancelRunCommand(ORG, "p1", "hecha")),
      () => resume.execute(new ResumeRunCommand(ORG, "p1", "hecha", "step")),
    ]) {
      const error = (await rejection(attempt())) as ConflictError;
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "run-finished");
    }
    assert.equal(await queue.isCancelled("hecha"), false);
  });

  test("reanudar una corrida que no está en pausa es un 409; en pausa, deja la orden a la cola", async () => {
    const runs = new InMemoryRunRepository();
    await runs.save(runRow("viva", "p1"));
    const queue = new InMemoryRunQueue();
    const resume = new ResumeRunHandler(projects, runs, queue);
    const error = (await rejection(resume.execute(new ResumeRunCommand(ORG, "p1", "viva", "continue")))) as ConflictError;
    assert.equal(error.code, "run-not-paused");

    await queue.pause("viva", { caseId: "c", stepId: null });
    await resume.execute(new ResumeRunCommand(ORG, "p1", "viva", "continue"));
    assert.equal(await queue.takeResume("viva"), "continue");
    assert.equal(await queue.takeResume("viva"), null);
  });
});

describe("enviar una petición suelta", () => {
  const template = {
    name: "x",
    operationId: "op",
    expectedStatus: 200,
    parameters: {},
    headers: {},
    body: { type: "none" },
    auth: "primary",
  };
  const previewer = { preview: async () => assert.fail("no debería llegar al previsualizador") } as never;

  test("proyecto ajeno 404, sin contrato 409, entorno de otro proyecto 404", async () => {
    const handler = (project: ProjectRow) =>
      new PreviewRequestHandler(
        projectsOf(project),
        { findById: async () => ({ id: "env-9", projectId: "otro" }) } as never,
        previewer,
      );
    const send = (project: ProjectRow) =>
      handler(project).execute(new PreviewRequestCommand(ORG, "p1", { environmentId: "env-9", template } as never));

    const foreign = (await rejection(send({ id: "p1", organizationId: "otra", activeSpecVersionId: "s" }))) as NotFoundError;
    assert.equal(foreign.code, "project-not-found");
    const noSpec = (await rejection(send({ id: "p1", organizationId: ORG, activeSpecVersionId: null }))) as ConflictError;
    assert.equal(noSpec.code, "no-active-spec");
    const wrongEnv = (await rejection(send({ id: "p1", organizationId: ORG, activeSpecVersionId: "s" }))) as NotFoundError;
    assert.equal(wrongEnv.code, "environment-not-found");
  });
});

describe("la retención", () => {
  test("sin días en la orden usa los del entorno, y con los dos a cero no toca nada", async () => {
    const runs = new InMemoryRunRepository();
    const old = runRow("vieja", "p1", {}, "passed");
    await runs.save({ ...old, finishedAt: new Date("2025-01-01T00:00:00.000Z") });
    const off = new PruneRunsHandler(runs, clock, { RETENTION_BODIES_DAYS: 0, RETENTION_RUNS_DAYS: 0 } as Env);
    assert.deepEqual(await off.execute(new PruneRunsCommand()), { bodiesPruned: 0, runsDeleted: 0 });
    assert.ok(await runs.findById("vieja"));

    const on = new PruneRunsHandler(runs, clock, { RETENTION_BODIES_DAYS: 0, RETENTION_RUNS_DAYS: 30 } as Env);
    assert.deepEqual(await on.execute(new PruneRunsCommand()), { bodiesPruned: 0, runsDeleted: 1 });
    assert.equal(await runs.findById("vieja"), null);
  });

  test("el programador no arranca sin política, barre al arrancar con ella y sobrevive a un barrido que falla", async () => {
    const executed: unknown[] = [];
    const bus = {
      execute: async (command: unknown) => {
        executed.push(command);
        throw new Error("la base se fue");
      },
    } as never;

    const disabled = new RetentionScheduler(bus, { RETENTION_SWEEP_HOURS: 6, RETENTION_BODIES_DAYS: 0, RETENTION_RUNS_DAYS: 0 } as Env);
    disabled.onApplicationBootstrap();
    disabled.onApplicationShutdown();
    const noHours = new RetentionScheduler(bus, { RETENTION_SWEEP_HOURS: 0, RETENTION_BODIES_DAYS: 7, RETENTION_RUNS_DAYS: 0 } as Env);
    noHours.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executed.length, 0);

    const enabled = new RetentionScheduler(bus, { RETENTION_SWEEP_HOURS: 6, RETENTION_BODIES_DAYS: 7, RETENTION_RUNS_DAYS: 0 } as Env);
    enabled.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executed.length, 1);
    assert.ok(executed[0] instanceof PruneRunsCommand);
    enabled.onApplicationShutdown();
  });

  test("vuelve a barrer en cada intervalo, también cuando lo que falla no es un Error", async (context) => {
    context.mock.timers.enable({ apis: ["setInterval"] });
    let sweeps = 0;
    const bus = {
      execute: async () => {
        sweeps += 1;
        if (sweeps === 2) throw "texto suelto";
        return { bodiesPruned: 0, runsDeleted: 0 };
      },
    } as never;
    const scheduler = new RetentionScheduler(bus, { RETENTION_SWEEP_HOURS: 1, RETENTION_BODIES_DAYS: 0, RETENTION_RUNS_DAYS: 3 } as Env);
    scheduler.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sweeps, 1);
    context.mock.timers.tick(60 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sweeps, 2);
    context.mock.timers.tick(60 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sweeps, 3);
    scheduler.onApplicationShutdown();
    context.mock.timers.tick(60 * 60 * 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sweeps, 3, "apagado, ya no barre");
  });
});

describe("la cola en memoria", () => {
  test("una corrida encolada antes de que haya trabajador espera a que lo haya", async () => {
    const queue = new InMemoryRunQueue();
    const handled: string[] = [];
    await queue.enqueue("temprana");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handled.length, 0);
    queue.process(async (runId) => void handled.push(runId));
    await queue.idle();
    assert.deepEqual(handled, ["temprana"]);
  });
});
