import { describe, expect, test } from "vitest";

import { addControlStep, CONTROL_PALETTE, flowNodeStatuses, problemsWith, toNodes } from "@/lib/workflow-draft";
import { subflowChoices, variablesWrittenBy } from "@/lib/workflow-subflow";
import type { WorkflowStepView } from "@/lib/types";

const CHILD = "00000000-0000-4000-8000-000000000002";

describe("el nodo sub-flujo", () => {
  test("está en la paleta, cae sin flujo elegido y lo pide hasta que se elige", () => {
    expect(CONTROL_PALETTE.find((item) => item.kind === "subflow")).toMatchObject({ glyph: "⧉", label: "Sub-flujo" });
    const base: WorkflowStepView[] = [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];
    const loose = addControlStep(base, "subflow", "crear");
    const node = loose.steps.find((step) => step.id === loose.id)!;
    expect(loose.id).toBe("subflujo");
    expect(node).toMatchObject({ kind: "subflow", dependsOn: ["crear"], subflow: { workflowId: "", inputs: [], outputs: [] } });
    expect(problemsWith(loose.steps).some((message) => message.includes("no tiene elegido el flujo"))).toBe(true);

    const chosen = loose.steps.map((step) =>
      step.id === loose.id
        ? { ...step, subflow: { workflowId: CHILD, inputs: [{ variable: "entityName", value: "{{x}}" }], outputs: ["thingId"] } }
        : step,
    );
    expect(problemsWith(chosen)).toEqual([]);
    expect(toNodes(chosen, [], []).find((item) => item.id === loose.id)).toMatchObject({
      type: "subflow",
      data: { chosen: true, inputs: 1, outputs: 1 },
    });

    const badName = chosen.map((step) =>
      step.id === loose.id ? { ...step, subflow: { ...step.subflow!, outputs: ["no vale"] } } : step,
    );
    expect(problemsWith(badName).some((message) => message.includes("nombre de variable"))).toBe(true);
  });

  test("dentro de un bucle es un problema", () => {
    const steps: WorkflowStepView[] = [
      { id: "listar", kind: "fetch", fetch: { method: "GET", url: "/x" } },
      { id: "bucle", kind: "loop", dependsOn: ["listar"], loop: { from: "listar", path: "data", as: "item" } },
      { id: "sub", kind: "subflow", dependsOn: ["bucle"], inLoop: "bucle", subflow: { workflowId: CHILD } },
    ];
    expect(problemsWith(steps).some((message) => message.includes("dentro de un bucle"))).toBe(true);
  });

  test("los casos del hijo encienden el nodo que lo ejecuta", () => {
    expect(
      flowNodeStatuses([
        { scenarioId: "workflow:f:sub", status: "queued" },
        { scenarioId: "workflow:f:sub>crear", status: "failed" },
        { scenarioId: "workflow:f:sub>otro>leer#1", status: "passed" },
        { scenarioId: "workflow:f:crear", status: "passed" },
      ]),
    ).toEqual({ sub: "failed", crear: "passed" });
  });

  test("el selector deja fuera el flujo abierto y marca archivados y los que ya lo ejecutan", () => {
    const flow = (id: string, status: "draft" | "ready" | "archived", steps: WorkflowStepView[] = []) => ({
      id,
      name: id.toUpperCase(),
      status,
      steps,
    });
    const choices = subflowChoices(
      [
        flow("a", "ready"),
        flow("b", "archived"),
        flow("c", "draft", [{ id: "s", kind: "subflow", subflow: { workflowId: "a" } }]),
        flow("d", "ready", [{ id: "x", requestTemplateId: "t" }]),
      ],
      "a",
    );
    expect(choices).toEqual([
      { id: "b", name: "B", steps: 0, archived: true, callsBack: false },
      { id: "c", name: "C", steps: 1, archived: false, callsBack: true },
      { id: "d", name: "D", steps: 1, archived: false, callsBack: false },
    ]);
  });

  test("ofrece como salidas lo que el hijo captura, asigna o devuelve", () => {
    expect(
      variablesWrittenBy([
        { id: "a", requestTemplateId: "t", captures: [{ variable: "thingId", from: "body", path: "data.id" }] },
        { id: "b", kind: "set", set: { assignments: [{ variable: "total", value: "1" }, { variable: "thingId", value: "2" }] } },
        { id: "c", kind: "subflow", subflow: { workflowId: CHILD, outputs: ["token"] } },
      ]),
    ).toEqual(["thingId", "total", "token"]);
  });
});
