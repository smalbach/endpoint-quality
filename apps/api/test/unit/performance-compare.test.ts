/**
 * Comparing two runs, checked directly.
 *
 * The comparison is pure arithmetic over two finished runs: which side won each metric, the delta
 * per endpoint, endpoints and thresholds that only one run carried. No repository, no clock.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { compareRuns } from "@/modules/performance/domain/compare";
import type {
  PerformanceEndpointStat,
  PerformanceRun,
  PerformanceSummary,
  PerformanceThresholdResult,
} from "@/modules/performance/domain/model";

const summary = (over: Partial<PerformanceSummary>): PerformanceSummary => ({
  requests: 100,
  failures: 0,
  errorRate: 0,
  rps: 50,
  minMs: 1,
  maxMs: 200,
  avgMs: 40,
  p50Ms: 35,
  p90Ms: 80,
  p95Ms: 100,
  p99Ms: 150,
  ...over,
});

const run = (
  id: string,
  over: {
    summary?: PerformanceSummary | null;
    endpoints?: PerformanceEndpointStat[];
    thresholds?: PerformanceThresholdResult[];
  },
): PerformanceRun => ({
  id,
  projectId: "p1",
  planId: "plan1",
  planName: "Carga",
  environmentId: "e1",
  status: "passed",
  definition: { scenarios: [], profile: { type: "constant", vus: 1, durationS: 1 }, thresholds: {} },
  progress: { elapsedS: 1, totalS: 1, requests: 100, vus: 1 },
  summary: "summary" in over ? (over.summary ?? null) : summary({}),
  windows: [],
  endpoints: over.endpoints ?? [],
  thresholds: over.thresholds ?? [],
  error: null,
  startedAt: new Date("2026-01-01T00:00:00Z"),
  finishedAt: new Date("2026-01-01T00:01:00Z"),
});

describe("comparar dos corridas", () => {
  test("los deltas van de base a comparada y nombran al ganador por métrica", () => {
    const base = run("a", { summary: summary({ p95Ms: 100, rps: 40, errorRate: 0.02 }) });
    const target = run("b", { summary: summary({ p95Ms: 80, rps: 50, errorRate: 0.05 }) });

    const view = compareRuns(base, target);
    const byKey = Object.fromEntries(view.metrics.map((metric) => [metric.metric, metric]));

    // p95 bajó: la comparada gana (menos latencia es mejor).
    assert.equal(byKey.p95Ms.delta, -20);
    assert.equal(byKey.p95Ms.better, "target");
    assert.equal(byKey.p95Ms.pct, -0.2);

    // rps subió: la comparada gana (más throughput es mejor).
    assert.equal(byKey.rps.delta, 10);
    assert.equal(byKey.rps.better, "target");

    // errores subieron: la base gana (menos error es mejor).
    assert.ok(Math.abs(byKey.errorRate.delta - 0.03) < 1e-9);
    assert.equal(byKey.errorRate.better, "base");
  });

  test("empate en una métrica es 'same' y sin pct cuando la base es 0", () => {
    const base = run("a", { summary: summary({ avgMs: 40, minMs: 0 }) });
    const target = run("b", { summary: summary({ avgMs: 40, minMs: 5 }) });
    const view = compareRuns(base, target);
    const avg = view.metrics.find((metric) => metric.metric === "avgMs")!;
    assert.equal(avg.delta, 0);
    assert.equal(avg.better, "same");
  });

  test("sin resumen en un lado no hay métricas", () => {
    const base = run("a", { summary: null });
    const target = run("b", {});
    assert.equal(compareRuns(base, target).metrics.length, 0);
  });

  test("los endpoints se alinean por método+ruta; los que faltan quedan en un lado", () => {
    const stat = (path: string, over: Partial<PerformanceEndpointStat>): PerformanceEndpointStat => ({
      method: "GET",
      path,
      requests: 10,
      failures: 0,
      errorRate: 0,
      p95Ms: 100,
      avgMs: 40,
      ...over,
    });
    const base = run("a", { endpoints: [stat("/a", { p95Ms: 100 }), stat("/only-base", {})] });
    const target = run("b", { endpoints: [stat("/a", { p95Ms: 120, errorRate: 0.1 }), stat("/only-target", {})] });

    const view = compareRuns(base, target);
    const shared = view.endpoints.find((endpoint) => endpoint.path === "/a")!;
    assert.equal(shared.p95Delta, 20);
    assert.ok(Math.abs(shared.errorRateDelta! - 0.1) < 1e-9);

    const onlyBase = view.endpoints.find((endpoint) => endpoint.path === "/only-base")!;
    assert.equal(onlyBase.target, null);
    assert.equal(onlyBase.p95Delta, null);

    const onlyTarget = view.endpoints.find((endpoint) => endpoint.path === "/only-target")!;
    assert.equal(onlyTarget.base, null);
  });

  test("los umbrales se alinean por etiqueta, con null donde un plan no lo tenía", () => {
    const base = run("a", { thresholds: [{ label: "p95 < 200ms", ok: true, actual: "100 ms", limit: "200 ms" }] });
    const target = run("b", {
      thresholds: [
        { label: "p95 < 200ms", ok: false, actual: "250 ms", limit: "200 ms" },
        { label: "error < 1%", ok: true, actual: "0%", limit: "1%" },
      ],
    });
    const view = compareRuns(base, target);
    const p95 = view.thresholds.find((threshold) => threshold.label === "p95 < 200ms")!;
    assert.equal(p95.base?.ok, true);
    assert.equal(p95.target?.ok, false);
    const err = view.thresholds.find((threshold) => threshold.label === "error < 1%")!;
    assert.equal(err.base, null);
    assert.equal(err.target?.ok, true);
  });
});
