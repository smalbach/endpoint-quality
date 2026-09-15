import { describe, expect, test } from "vitest";
import {
  DEFAULT_RUN_SETTINGS,
  normalizeRunSettings,
  runSettingsBody,
  runSettingsProblem,
  runSettingsSummary,
} from "./run-settings";

describe("normalizeRunSettings", () => {
  test("lo que no se entiende vuelve al valor por defecto", () => {
    expect(normalizeRunSettings(null)).toEqual(DEFAULT_RUN_SETTINGS);
    expect(normalizeRunSettings({ pauseMode: "turbo", delayMs: "x", concurrency: null })).toEqual(DEFAULT_RUN_SETTINGS);
  });

  test("los números fuera de rango se acercan al límite", () => {
    const settings = normalizeRunSettings({ delayMs: 90_000, concurrency: 40 });
    expect(settings.delayMs).toBe(30_000);
    expect(settings.concurrency).toBe(10);
    expect(normalizeRunSettings({ delayMs: -5, concurrency: 0 })).toMatchObject({ delayMs: 0, concurrency: 1 });
  });

  test("las paradas en nodos que el flujo ya no tiene se descartan", () => {
    const settings = normalizeRunSettings(
      { pauseMode: "breakpoints", breakpoints: ["crear", "borrado", "crear", 7] },
      ["listar", "crear"],
    );
    expect(settings.breakpoints).toEqual(["crear"]);
  });
});

describe("runSettingsBody", () => {
  test("sin cambios manda solo lo que la corrida ya mandaba", () => {
    expect(runSettingsBody(DEFAULT_RUN_SETTINGS)).toEqual({ delayMs: 0, concurrency: 1 });
  });

  test("las paradas solo viajan en su modo", () => {
    const base = { ...DEFAULT_RUN_SETTINGS, breakpoints: ["crear"] };
    expect(runSettingsBody({ ...base, pauseMode: "step" })).toEqual({ delayMs: 0, concurrency: 1, pauseMode: "step" });
    expect(runSettingsBody({ ...base, pauseMode: "breakpoints", stopOnFailure: true })).toEqual({
      delayMs: 0,
      concurrency: 1,
      pauseMode: "breakpoints",
      breakpoints: ["crear"],
      stopOnFailure: true,
    });
  });
});

describe("runSettingsProblem y runSettingsSummary", () => {
  test("puntos de parada sin ningún nodo no se puede lanzar", () => {
    expect(runSettingsProblem({ ...DEFAULT_RUN_SETTINGS, pauseMode: "breakpoints" })).toMatch(/al menos un nodo/);
    expect(runSettingsProblem({ ...DEFAULT_RUN_SETTINGS, pauseMode: "step" })).toBeNull();
  });

  test("el resumen calla cuando todo está por defecto y habla cuando no", () => {
    expect(runSettingsSummary(DEFAULT_RUN_SETTINGS)).toBeNull();
    expect(
      runSettingsSummary({ pauseMode: "step", breakpoints: [], delayMs: 1500, concurrency: 2, stopOnFailure: true }),
    ).toBe("Paso a paso · 1.5 s · ×2 · para al fallar");
    expect(runSettingsSummary({ ...DEFAULT_RUN_SETTINGS, pauseMode: "breakpoints", breakpoints: ["a"], delayMs: 300 })).toBe(
      "1 parada · 300 ms",
    );
  });
});
