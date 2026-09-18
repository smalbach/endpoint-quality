import { describe, expect, test } from "vitest";
import { CONTROL_PALETTE, addControlStep, connectStep, problemsWith, toNodes } from "@/lib/workflow-draft";
import { formatWait, openHooks, webhookTimeoutProblem } from "@/lib/workflow-webhook";
import type { WorkflowStepView } from "@/lib/types";

describe("el nodo Esperar webhook", () => {
  test("está en la paleta como ⚓ Webhook y cae con una espera de un minuto por POST", () => {
    expect(CONTROL_PALETTE.find((item) => item.kind === "webhook")).toMatchObject({ glyph: "⚓", label: "Webhook" });

    const dropped = addControlStep([], "webhook");
    const node = dropped.steps.find((step) => step.id === dropped.id)!;
    expect(node.webhook).toEqual({ timeoutMs: 60_000, method: "POST" });
    // No lee ningún paso: suelto también es válido.
    expect(problemsWith(dropped.steps)).toEqual([]);
    expect(toNodes(dropped.steps, [], []).find((item) => item.id === dropped.id)).toMatchObject({
      type: "webhook",
      data: { timeoutMs: 60_000, method: "POST", checks: 0, captures: 0 },
    });
  });

  test("avisa de una espera fuera de 1 s – 10 min", () => {
    const { steps, id } = addControlStep([], "webhook");
    const withTimeout = (timeoutMs: number) =>
      steps.map((step) => (step.id === id ? { ...step, webhook: { timeoutMs } } : step));
    expect(problemsWith(withTimeout(500)).some((message) => message.includes("entre 1 s y 10 min"))).toBe(true);
    expect(problemsWith(withTimeout(600_001)).some((message) => message.includes("entre 1 s y 10 min"))).toBe(true);
    expect(problemsWith(withTimeout(600_000))).toEqual([]);
    expect(webhookTimeoutProblem(undefined)).toBe("falta cuánto esperar.");
  });

  test("no puede quedar dentro del cuerpo de un bucle", () => {
    const start: WorkflowStepView[] = [{ id: "listar", requestTemplateId: "t1", position: { x: 40, y: 60 } }];
    const loop = addControlStep(start, "loop", "listar");
    const hook = addControlStep(loop.steps, "webhook");
    const inside = connectStep(hook.steps, loop.id, hook.id, "each");
    expect(
      problemsWith(inside).some((message) => message.includes("está dentro de un bucle: no puede esperar ahí")),
    ).toBe(true);
    // En el lado «fin» no hay problema.
    expect(problemsWith(connectStep(hook.steps, loop.id, hook.id, "done"))).toEqual([]);
  });

  test("la tarjeta de la URL se va en cuanto el stream dice que su caso terminó", () => {
    const hook = {
      caseId: "c1",
      stepId: "pago",
      url: "http://localhost:3001/hooks/flows/x",
      method: "POST" as const,
      expiresAt: "2026-01-01T00:00:00Z",
    };
    expect(openHooks([hook], () => "running")).toEqual([hook]);
    expect(openHooks([hook], () => undefined)).toEqual([hook]);
    expect(openHooks([hook], () => "passed")).toEqual([]);
    expect(openHooks([hook], () => "skipped")).toEqual([]);
    expect(openHooks(undefined, () => "running")).toEqual([]);
  });

  test("la espera se lee en segundos o minutos", () => {
    expect(formatWait(45_000)).toBe("45 s");
    expect(formatWait(120_000)).toBe("2 min");
    expect(formatWait(90_000)).toBe("1 min 30 s");
  });
});
