import { describe, expect, test } from "vitest";

import { DEFAULT_RUN_SETTINGS, type RunSettings } from "@/lib/run-settings";
import { activeBreakpoints, pausedNodeId, toggleBreakpoint } from "@/lib/run-pause";

const cases = [
  { id: "c1", scenarioId: "workflow:flow-a:listar" },
  { id: "c2", scenarioId: "workflow:flow-a:crear#1" },
  { id: "c3", scenarioId: "workflow:flow-b:crear" },
  { id: "c4", scenarioId: "GET /things" },
];

describe("pausedNodeId", () => {
  test("el nodo del flujo abierto donde espera la corrida", () => {
    expect(pausedNodeId({ caseId: "c1", stepId: "listar" }, cases, "flow-a")).toBe("listar");
  });

  test("una fila del dataset sigue siendo el mismo nodo", () => {
    expect(pausedNodeId({ caseId: "c2", stepId: "crear" }, cases, "flow-a")).toBe("crear");
  });

  test("en una suite, el mismo id en otro flujo no enciende el nodo de este", () => {
    expect(pausedNodeId({ caseId: "c3", stepId: "crear" }, cases, "flow-a")).toBeNull();
    expect(pausedNodeId({ caseId: "c3", stepId: "crear" }, cases, "flow-b")).toBe("crear");
  });

  test("sin pausa, sin nodo, sin flujo abierto o sin el caso todavía: nada", () => {
    expect(pausedNodeId(null, cases, "flow-a")).toBeNull();
    expect(pausedNodeId(undefined, cases, "flow-a")).toBeNull();
    expect(pausedNodeId({ caseId: "c4", stepId: null }, cases, "flow-a")).toBeNull();
    expect(pausedNodeId({ caseId: "c1", stepId: "listar" }, cases, undefined)).toBeNull();
    expect(pausedNodeId({ caseId: "c9", stepId: "listar" }, cases, "flow-a")).toBeNull();
    expect(pausedNodeId({ caseId: "c1", stepId: "listar" }, [], "flow-a")).toBeNull();
  });

  test("un caso que no es de ese nodo no se da por bueno", () => {
    expect(pausedNodeId({ caseId: "c1", stepId: "crear" }, cases, "flow-a")).toBeNull();
  });
});

describe("toggleBreakpoint", () => {
  const settings = (overrides: Partial<RunSettings> = {}): RunSettings => ({ ...DEFAULT_RUN_SETTINGS, ...overrides });

  test("marcar un nodo en una corrida normal pasa a puntos de parada", () => {
    const next = toggleBreakpoint(settings(), "crear");
    expect(next.pauseMode).toBe("breakpoints");
    expect(next.breakpoints).toEqual(["crear"]);
  });

  test("marcar desde paso a paso también cambia el modo: pedir parar aquí es parar solo aquí", () => {
    const next = toggleBreakpoint(settings({ pauseMode: "step" }), "crear");
    expect(next.pauseMode).toBe("breakpoints");
    expect(activeBreakpoints(next)).toEqual(["crear"]);
  });

  test("se añade a los que ya había y conserva el resto de ajustes", () => {
    const next = toggleBreakpoint(settings({ pauseMode: "breakpoints", breakpoints: ["listar"], delayMs: 300 }), "crear");
    expect(next.breakpoints).toEqual(["listar", "crear"]);
    expect(next.delayMs).toBe(300);
  });

  test("quitar una marca la quita; quitar la última vuelve a una corrida normal", () => {
    const two = settings({ pauseMode: "breakpoints", breakpoints: ["listar", "crear"] });
    const one = toggleBreakpoint(two, "listar");
    expect(one).toMatchObject({ pauseMode: "breakpoints", breakpoints: ["crear"] });
    expect(toggleBreakpoint(one, "crear")).toMatchObject({ pauseMode: "none", breakpoints: [] });
  });

  test("una marca guardada de otro modo vuelve activa en vez de borrarse", () => {
    const next = toggleBreakpoint(settings({ pauseMode: "none", breakpoints: ["crear"] }), "crear");
    expect(next).toMatchObject({ pauseMode: "breakpoints", breakpoints: ["crear"] });
  });

  test("las marcas solo cuentan en modo puntos de parada", () => {
    expect(activeBreakpoints(settings({ pauseMode: "step", breakpoints: ["crear"] }))).toEqual([]);
  });
});
