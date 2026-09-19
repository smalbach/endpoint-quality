/**
 * Performance: a plan created without a name, a plan with no scenarios left to start, a threshold
 * only the older run had, the scenario picker's last slot, and a run that hits the sample ceiling
 * in the middle of an iteration.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FixedClock } from "@/shared/clock/clock.port";
import type { DomainError } from "@/shared/errors/domain-error";
import type { Project } from "@/modules/projects/domain/model";
import type { SafeFetchResult } from "@/shared/http/safe-fetch";
import { CreatePlanCommand, CreatePlanHandler } from "@/modules/performance/application/commands/manage-plan";
import { StartRunCommand, StartRunHandler } from "@/modules/performance/application/commands/manage-run";
import { compareRuns } from "@/modules/performance/domain/compare";
import { pickScenario } from "@/modules/performance/domain/load";
import { summarize } from "@/modules/performance/domain/stats";
import type {
  PerformancePlanDefinition,
  PerformanceRun,
  PerformanceScenario,
} from "@/modules/performance/domain/model";
import { PerformanceExecutor } from "@/modules/performance/infrastructure/performance-executor";
import { PerformanceProgressStream } from "@/modules/performance/infrastructure/performance-progress.stream";
import {
  InMemoryEnvironmentRepository,
  InMemoryPerformancePlanRepository,
  InMemoryPerformanceRunRepository,
  InMemoryProjectRepository,
} from "@test/support/in-memory-repositories";

const ORG = "org-1";
const PROJECT = "proj-1";
const T0 = new Date("2026-01-01T00:00:00.000Z");

function projects() {
  const repository = new InMemoryProjectRepository();
  void repository.save({
    id: PROJECT,
    organizationId: ORG,
    name: "P",
    slug: "p",
    deletedAt: null,
  } as unknown as Project);
  return repository;
}

describe("los planes de carga", () => {
  test("crear sin nombre es un 422 que señala el nombre", async () => {
    const plans = new InMemoryPerformancePlanRepository();
    await assert.rejects(
      new CreatePlanHandler(projects(), plans, new FixedClock(T0)).execute(
        new CreatePlanCommand(ORG, PROJECT, {}, "u"),
      ),
      (error: DomainError) => {
        assert.equal(error.code, "performance-plan-invalid");
        assert.deepEqual(error.fields, [{ field: "name", detail: "Escriba un nombre" }]);
        return true;
      },
    );
    assert.equal(plans.rows.size, 0);
  });

  test("un plan guardado sin escenarios no arranca: lo rechaza el esquema como plan inválido", async () => {
    const plans = new InMemoryPerformancePlanRepository();
    const runs = new InMemoryPerformanceRunRepository();
    const enqueued: string[] = [];
    await plans.save({
      id: "plan-1",
      projectId: PROJECT,
      name: "Vacío",
      description: null,
      definition: { scenarios: [], profile: { type: "constant", vus: 1, durationS: 5 }, thresholds: {} },
      createdAt: T0,
      updatedAt: T0,
      updatedBy: "u",
    });
    const handler = new StartRunHandler(
      projects(),
      plans,
      runs,
      new InMemoryEnvironmentRepository(),
      { enqueue: async (id: string) => void enqueued.push(id) } as never,
      new FixedClock(T0),
    );
    await assert.rejects(
      handler.execute(new StartRunCommand(ORG, PROJECT, "plan-1", "env-1")),
      (error: DomainError) => {
        assert.equal(error.kind, "invalid");
        assert.equal(error.code, "performance-plan-invalid");
        assert.ok(
          error.fields.some((field) => field.field.startsWith("scenarios")),
          JSON.stringify(error.fields),
        );
        return true;
      },
    );
    assert.equal(runs.rows.size, 0);
    assert.deepEqual(enqueued, []);
  });
});

describe("comparar dos corridas", () => {
  test("un umbral que solo tenía la corrida base deja la comparada en null", () => {
    const run = (id: string, thresholds: PerformanceRun["thresholds"]): PerformanceRun =>
      ({
        id,
        planName: "P",
        status: "passed",
        startedAt: T0,
        summary: null,
        endpoints: [],
        thresholds,
      }) as unknown as PerformanceRun;
    const view = compareRuns(run("a", [{ label: "p95", ok: true, actual: "90 ms", limit: "≤ 100 ms" }]), run("b", []));
    assert.deepEqual(view.thresholds, [{ label: "p95", base: { ok: true, actual: "90 ms" }, target: null }]);
  });
});

describe("elegir escenario por peso", () => {
  const scenario = (id: string, weight: number) =>
    ({ id, name: id, weight, thinkMs: 0, requests: [] }) as PerformanceScenario;

  test("lo que sobra tras los demás cae en el último, también al tope del intervalo", () => {
    const scenarios = [scenario("a", 1), scenario("b", 1), scenario("c", 2)];
    assert.equal(pickScenario(scenarios, 0.2)?.id, "a");
    assert.equal(pickScenario(scenarios, 0.3)?.id, "b");
    assert.equal(pickScenario(scenarios, 0.6)?.id, "c");
    assert.equal(pickScenario(scenarios, 1)?.id, "c");
    assert.equal(pickScenario([scenario("solo", 3)], 0.99)?.id, "solo");
  });
});

describe("el techo de muestras", () => {
  test("una iteración que lo encuentra lleno a medias deja de enviar, y la corrida se juzga con lo medido", async () => {
    const MAX_SAMPLES = 200_000;
    const definition: PerformancePlanDefinition = {
      // Two users walking a long scenario in lockstep: the ceiling lands in the middle of both walks.
      scenarios: [
        {
          id: "s",
          name: "Largo",
          weight: 1,
          thinkMs: 0,
          requests: Array.from({ length: 150_000 }, () => ({ method: "GET", path: "/x" })),
        },
      ],
      profile: { type: "constant", vus: 2, durationS: 60 },
      thresholds: {},
    };
    const stored = new Map<string, PerformanceRun>();
    stored.set("perf-1", {
      id: "perf-1",
      projectId: PROJECT,
      planId: "plan-1",
      planName: "Plan",
      environmentId: "e1",
      status: "queued",
      definition,
      progress: { elapsedS: 0, totalS: 60, requests: 0, vus: 0 },
      summary: null,
      windows: [],
      endpoints: [],
      thresholds: [],
      error: null,
      startedAt: T0,
      finishedAt: null,
    });
    let sent = 0;
    const answer: SafeFetchResult = {
      status: 200,
      headers: {},
      setCookie: [],
      body: "{}",
      finalUrl: "",
      durationMs: 1,
      timing: { dnsMs: 0, ttfbMs: 1, downloadMs: 0 },
    };
    const executor = new PerformanceExecutor(
      {
        findById: async (id: string) => stored.get(id) ?? null,
        save: async (run: PerformanceRun) => void stored.set(run.id, run),
      } as never,
      { process: () => undefined, isCancelled: () => false } as never,
      { findById: async () => ({ id: "e1", baseUrl: "http://load.test", variables: {} }) } as never,
      { decrypt: (payload: string) => payload } as never,
      { request: async () => ((sent += 1), answer) } as never,
      new FixedClock(T0),
      new PerformanceProgressStream(),
    );
    await executor.execute("perf-1");
    const finished = stored.get("perf-1")!;
    assert.equal(finished.error, null);
    assert.equal(finished.status, "passed");
    // Each user looks before it sends, so at most the ones already in flight — one per other user —
    // land past the ceiling; nobody walks the rest of its 150 000 requests.
    assert.ok(sent >= MAX_SAMPLES && sent <= MAX_SAMPLES + 1, `enviadas ${sent}`);
    assert.equal(finished.summary?.requests, sent);
    assert.equal(finished.endpoints.length, 1);
    assert.equal(finished.endpoints[0].requests, sent);
  });
});

describe("el resumen de una corrida enorme", () => {
  test("el mínimo y el máximo salen también con 200 000 muestras", () => {
    const samples = Array.from({ length: 200_000 }, (_, index) => ({
      method: "GET",
      path: "/x",
      ok: true,
      status: 200,
      durationMs: 5 + (index % 90),
      atMs: index,
    }));
    const summary = summarize(samples as never, 10);
    assert.equal(summary.requests, 200_000);
    assert.equal(summary.minMs, 5);
    assert.equal(summary.maxMs, 94);
  });
});
