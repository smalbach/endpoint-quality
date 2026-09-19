/**
 * The corners of the performance domain the other suites leave: the p99 and throughput limits, a
 * sample stamped before the run started, a threshold only the newer run carried, and a definition
 * that is not even an object.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { evaluateThresholds, summarize, toWindows, type Sample } from "@/modules/performance/domain/stats";
import { compareRuns } from "@/modules/performance/domain/compare";
import { safeParsePlanDefinition } from "@/modules/performance/domain/plan-schema";
import type { PerformanceRun } from "@/modules/performance/domain/model";

const sample = (atMs: number, durationMs: number, ok = true): Sample => ({ atMs, durationMs, ok, method: "GET", path: "/x" });

describe("los umbrales que faltaban", () => {
  test("p99 es un techo y el rendimiento un suelo, cada uno con su texto", () => {
    const summary = summarize(
      Array.from({ length: 100 }, (_, index) => sample(index * 10, index + 1)),
      10,
    );
    const [p99, rps] = evaluateThresholds(summary, { p99Ms: 50, minRps: 5 });
    assert.deepEqual(p99, { label: "p99", ok: false, actual: `${summary.p99Ms} ms`, limit: "≤ 50 ms" });
    assert.deepEqual(rps, { label: "Rendimiento", ok: true, actual: `${summary.rps} req/s`, limit: "≥ 5 req/s" });

    const [strict] = evaluateThresholds(summary, { minRps: 1000 });
    assert.equal(strict.ok, false);
    const [loose] = evaluateThresholds(summary, { p99Ms: 1000 });
    assert.equal(loose.ok, true);
  });
});

describe("las ventanas", () => {
  test("una muestra con marca anterior al arranque no cae en ninguna ventana", () => {
    const windows = toWindows([sample(-500, 10), sample(100, 20, false), sample(6_000, 30)], 10, () => 2);
    assert.equal(windows.length, 2);
    assert.deepEqual(
      windows.map((window) => [window.requests, window.failures, window.vus]),
      [
        [1, 1, 2],
        [1, 0, 2],
      ],
    );
    assert.equal(windows[0].errorRate, 1);
  });
});

describe("comparar corridas", () => {
  const run = (id: string, thresholds: PerformanceRun["thresholds"]): PerformanceRun => ({
    id,
    projectId: "p",
    planId: "plan",
    planName: "Plan",
    environmentId: "e",
    status: "passed",
    definition: { scenarios: [], profile: { type: "constant", vus: 1, durationS: 1 }, thresholds: {} },
    progress: { elapsedS: 1, totalS: 1, requests: 0, vus: 0 },
    summary: null,
    windows: [],
    endpoints: [],
    thresholds,
    error: null,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    finishedAt: null,
  });

  test("un umbral que solo tiene la corrida nueva sale con la base vacía", () => {
    const view = compareRuns(
      run("a", []),
      run("b", [{ label: "p99", ok: false, actual: "900 ms", limit: "≤ 500 ms" }]),
    );
    assert.deepEqual(view.thresholds, [{ label: "p99", base: null, target: { ok: false, actual: "900 ms" } }]);
  });
});

describe("el esquema del plan", () => {
  test("algo que ni siquiera es un objeto se reporta contra la definición entera", () => {
    const parsed = safeParsePlanDefinition(null);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.issues[0].field, "definition");
  });
});
