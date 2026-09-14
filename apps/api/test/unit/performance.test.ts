/**
 * The load-testing arithmetic, checked directly.
 *
 * A wrong percentile or error rate is a decision made on a lie, so the numbers are the part worth
 * asserting. Pure functions over plain samples — no clock, no network.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { activeVusAt, peakVus, pickScenario, totalDurationS } from "@/modules/performance/domain/load";
import {
  byEndpoint,
  evaluateThresholds,
  percentile,
  summarize,
  toWindows,
  type Sample,
} from "@/modules/performance/domain/stats";
import type { LoadProfile, PerformanceScenario } from "@/modules/performance/domain/model";

describe("la forma de la carga", () => {
  test("constant mantiene los VUs; ramp interpola; spike sube en el tercio central", () => {
    const constant: LoadProfile = { type: "constant", vus: 10, durationS: 60 };
    assert.equal(activeVusAt(constant, 0), 10);
    assert.equal(activeVusAt(constant, 30), 10);

    const ramp: LoadProfile = { type: "ramp", startVus: 0, endVus: 100, durationS: 100 };
    assert.equal(activeVusAt(ramp, 0), 1); // nunca menos de 1
    assert.equal(activeVusAt(ramp, 50), 50);
    assert.equal(activeVusAt(ramp, 100), 100);

    const spike: LoadProfile = { type: "spike", baseVus: 5, peakVus: 50, durationS: 90 };
    assert.equal(activeVusAt(spike, 10), 5); // primer tercio: base
    assert.equal(activeVusAt(spike, 45), 50); // tercio central: pico
    assert.equal(activeVusAt(spike, 80), 5); // último tercio: base
  });

  test("pico y duración salen del perfil, y clampan fuera de rango", () => {
    assert.equal(peakVus({ type: "ramp", startVus: 2, endVus: 40, durationS: 30 }), 40);
    assert.equal(totalDurationS({ type: "constant", vus: 3, durationS: 0 }), 1);
    const ramp: LoadProfile = { type: "ramp", startVus: 10, endVus: 20, durationS: 10 };
    assert.equal(activeVusAt(ramp, -5), 10);
    assert.equal(activeVusAt(ramp, 999), 20);
  });

  test("elegir escenario respeta el peso y cae en el primero si todos son cero", () => {
    const scenarios: PerformanceScenario[] = [
      { id: "a", name: "A", weight: 1, thinkMs: 0, requests: [] },
      { id: "b", name: "B", weight: 3, thinkMs: 0, requests: [] },
    ];
    assert.equal(pickScenario(scenarios, 0.1)?.id, "a"); // 0.1*4 = 0.4 < 1
    assert.equal(pickScenario(scenarios, 0.5)?.id, "b"); // 0.5*4 = 2, cae en B
    const zero: PerformanceScenario[] = [
      { id: "x", name: "X", weight: 0, thinkMs: 0, requests: [] },
      { id: "y", name: "Y", weight: 0, thinkMs: 0, requests: [] },
    ];
    assert.equal(pickScenario(zero, 0.9)?.id, "x");
    assert.equal(pickScenario([], 0.5), undefined);
  });
});

describe("los números de una corrida", () => {
  const samples = (): Sample[] =>
    Array.from({ length: 100 }, (_unused, index) => ({
      atMs: index * 100,
      durationMs: index + 1, // 1..100 ms
      ok: index !== 0 && index !== 1, // dos fallos
      method: index % 2 ? "POST" : "GET",
      path: index % 2 ? "/orders" : "/health",
    }));

  test("el percentil es nearest-rank y el vacío es cero", () => {
    assert.equal(percentile([], 95), 0);
    assert.equal(percentile([10, 20, 30, 40, 50], 100), 50);
    // 95 de 1..100 es el 95º más lento.
    assert.equal(
      percentile(
        Array.from({ length: 100 }, (_u, i) => i + 1),
        95,
      ),
      95,
    );
  });

  test("el resumen cuenta fallos, tasa y rps sobre el tiempo real", () => {
    const summary = summarize(samples(), 10);
    assert.equal(summary.requests, 100);
    assert.equal(summary.failures, 2);
    assert.equal(summary.errorRate, 0.02);
    assert.equal(summary.rps, 10); // 100 req / 10 s
    assert.equal(summary.p95Ms, 95);
    assert.equal(summary.minMs, 1);
    assert.equal(summary.maxMs, 100);
  });

  test("las ventanas son de 5 s, con ceros donde no hubo tráfico", () => {
    const windows = toWindows(samples(), 20, () => 4, 5);
    assert.equal(windows.length, 4);
    // Los 100 samples caen en [0, 10s); las ventanas 3ª y 4ª están vacías.
    assert.equal(windows[0].requests + windows[1].requests, 100);
    assert.equal(windows[3].requests, 0);
    assert.equal(windows[3].rps, 0);
    assert.equal(windows[0].vus, 4);
  });

  test("el desglose por endpoint separa método y ruta, peor p95 primero", () => {
    const stats = byEndpoint(samples());
    assert.equal(stats.length, 2);
    assert.ok(stats[0].p95Ms >= stats[1].p95Ms);
    const orders = stats.find((stat) => stat.path === "/orders");
    assert.equal(orders?.method, "POST");
  });

  test("solo se comprueban los umbrales puestos; ausente no es aprobado", () => {
    const summary = summarize(samples(), 10);
    const results = evaluateThresholds(summary, { p95Ms: 90, maxErrorRate: 0.05 });
    assert.equal(results.length, 2);
    assert.equal(results.find((r) => r.label === "p95")?.ok, false); // 95 > 90
    assert.equal(results.find((r) => r.label === "Tasa de error")?.ok, true); // 2% < 5%
    assert.deepEqual(evaluateThresholds(summary, {}), []);
  });
});
