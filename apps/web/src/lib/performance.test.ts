import { describe, expect, test } from "vitest";

import { describeProfile, emptyPlanDefinition, formatMs, formatPct, isTerminal, peakVus } from "./performance";

describe("rendimiento", () => {
  test("terminal es todo lo que ya no va a cambiar", () => {
    expect(["passed", "failed", "cancelled", "error"].every((status) => isTerminal(status as never))).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  test("cada perfil se dice en una frase y sabe su pico", () => {
    expect(describeProfile({ type: "constant", vus: 50, durationS: 60 })).toBe("50 usuarios · 60 s");
    expect(peakVus({ type: "constant", vus: 50, durationS: 60 })).toBe(50);

    expect(describeProfile({ type: "ramp", startVus: 0, endVus: 100, durationS: 120 })).toBe("0→100 · 120 s");
    expect(peakVus({ type: "ramp", startVus: 80, endVus: 20, durationS: 120 })).toBe(80);

    expect(describeProfile({ type: "spike", baseVus: 5, peakVus: 50, durationS: 90 })).toBe("5↑50 · 90 s");
    expect(peakVus({ type: "spike", baseVus: 5, peakVus: 50, durationS: 90 })).toBe(50);
  });

  test("un plan vacío ya se puede lanzar: un escenario, carga constante y umbrales", () => {
    expect(emptyPlanDefinition()).toEqual({
      scenarios: [{ id: "s1", name: "Escenario", weight: 1, thinkMs: 0, requests: [{ method: "GET", path: "/" }] }],
      profile: { type: "constant", vus: 10, durationS: 30 },
      thresholds: { p95Ms: 500, maxErrorRate: 0.01 },
    });
  });

  test("milisegundos y porcentajes", () => {
    expect(formatMs(12.6)).toBe("13 ms");
    expect(formatMs(1_234)).toBe("1.23 s");
    expect(formatPct(0.0123)).toBe("1.23%");
  });
});
