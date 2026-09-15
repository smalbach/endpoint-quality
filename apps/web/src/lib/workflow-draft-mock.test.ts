import { describe, expect, test } from "vitest";
import { addControlStep, CONTROL_PALETTE, connectStep, problemsWith, toNodes, variablesFor } from "@/lib/workflow-draft";
import { mockBodyProblem, mockSampleBody } from "@/lib/mock-draft";
import type { WorkflowStepView } from "@/lib/types";

describe("el nodo mock", () => {
  const base: WorkflowStepView[] = [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];
  const withMock = (steps: WorkflowStepView[], id: string, change: Partial<NonNullable<WorkflowStepView["mock"]>>) =>
    steps.map((step) => (step.id === id ? { ...step, mock: { ...step.mock!, ...change } } : step));

  test("cae de la paleta con una respuesta JSON válida, suelto y sin avisos", () => {
    expect(CONTROL_PALETTE.find((entry) => entry.kind === "mock")).toMatchObject({ glyph: "◌", label: "Mock" });
    const { steps, id } = addControlStep(base, "mock");
    expect(id).toBe("mock");
    const mock = steps.find((step) => step.id === id)!;
    expect(mock.kind).toBe("mock");
    expect(mock.mock).toMatchObject({ status: 200, headers: { "content-type": "application/json" } });
    expect(mock.dependsOn).toBeUndefined();
    expect(problemsWith(steps)).toEqual([]);
    expect(toNodes(steps, [], []).find((node) => node.id === id)).toMatchObject({
      type: "mock",
      data: { name: "mock", status: 200, delayMs: 0, captures: 0, checks: 0 },
    });
  });

  test("avisa del body que no es JSON cuando el content-type lo dice, del estado y del retardo", () => {
    const { steps, id } = addControlStep(base, "mock");
    const problems = (change: Partial<NonNullable<WorkflowStepView["mock"]>>) => problemsWith(withMock(steps, id, change));
    expect(problems({ body: '{"id": ' }).some((message) => message.includes("no es JSON válido"))).toBe(true);
    // Las plantillas cuentan como un valor: {{total}} sin comillas no rompe el JSON.
    expect(problems({ body: '{"id": "{{thingId}}", "total": {{total}}}' })).toEqual([]);
    expect(problems({ headers: { "Content-Type": "text/plain" }, body: "{roto" })).toEqual([]);
    expect(problems({ headers: undefined, body: "{roto" })).toEqual([]);
    expect(problems({ status: 700 }).some((message) => message.includes("100–599"))).toBe(true);
    expect(problems({ delayMs: 90_000 }).some((message) => message.includes("60 000"))).toBe(true);
  });

  test("lo que captura llega a los pasos siguientes, y sus campos se ofrecen como capturas", () => {
    const { steps, id } = addControlStep(base, "mock");
    const captured = steps.map((step) =>
      step.id === id ? { ...step, captures: [{ variable: "pedidoId", from: "body" as const, path: "id" }] } : step,
    );
    const { steps: after, id: next } = addControlStep(captured, "set", id);
    const wired = connectStep(after, id, next);
    expect(variablesFor(wired, next, [])).toContain("pedidoId");

    expect(mockSampleBody({ status: 200, body: '{"id": "{{x}}", "n": {{y}}}' })).toEqual({ id: "0", n: 0 });
    expect(mockSampleBody({ status: 200, body: "texto" })).toBeUndefined();
    expect(mockBodyProblem({ status: 200, headers: { "content-type": "application/json" }, body: "[" })).toMatch(/JSON/);
  });
});
