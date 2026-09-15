import { describe, expect, test } from "vitest";
import { addControlStep, problemsWith, toNodes } from "@/lib/workflow-draft";
import { notifyProblems, notifyVariableHint, webhookVariables } from "@/lib/workflow-notify";
import type { WorkflowStepView } from "@/lib/types";

describe("el nodo notificar", () => {
  const base: WorkflowStepView[] = [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];

  test("cae con Slack y sin variable ni mensaje, y avisa de las dos cosas", () => {
    const added = addControlStep(base, "notify");
    const node = added.steps.find((step) => step.id === added.id)!;
    expect(node.kind).toBe("notify");
    expect(node.notify).toEqual({ channel: "slack", urlVariable: "", message: "" });
    const problems = problemsWith(added.steps);
    expect(problems.some((message) => message.includes("no dice qué variable"))).toBe(true);
    expect(problems.some((message) => message.includes("no tiene mensaje"))).toBe(true);

    const ready = added.steps.map((step) =>
      step.id === added.id
        ? { ...step, notify: { channel: "webhook" as const, urlVariable: "HOOK_URL", message: "creado {{thingId}}", onError: "fail" as const } }
        : step,
    );
    expect(problemsWith(ready)).toEqual([]);
    expect(toNodes(ready, [], []).find((item) => item.id === added.id)).toMatchObject({
      type: "notify",
      data: { channel: "webhook", urlVariable: "HOOK_URL", message: "creado {{thingId}}", failsFlow: true },
    });
  });

  test("una URL pegada donde va el nombre no se acepta", () => {
    const step: WorkflowStepView = {
      id: "aviso",
      kind: "notify",
      notify: { channel: "slack", urlVariable: "https://hooks.slack.com/services/T/B/x", message: "hola" },
    };
    expect(notifyProblems(step).map((problem) => problem.message)).toEqual([
      expect.stringContaining("guarda la URL en el entorno"),
    ]);
    expect(notifyProblems({ ...step, notify: { ...step.notify!, urlVariable: "1malo" } })[0].message).toContain("inválido");
  });

  test("ofrece primero las variables que parecen un webhook y dice si falta o no es sensible", () => {
    const variables = {
      baseToken: { initial: "", current: "x", sensitive: true },
      SLACK_WEBHOOK: { initial: "", current: "https://hooks", sensitive: true },
      apiUrl: { initial: "", current: "https://a", sensitive: false },
    };
    expect(webhookVariables(variables).map((item) => item.name)).toEqual(["apiUrl", "SLACK_WEBHOOK", "baseToken"]);
    expect(notifyVariableHint("SLACK_WEBHOOK", variables)).toBeNull();
    expect(notifyVariableHint("apiUrl", variables)?.tone).toBe("info");
    expect(notifyVariableHint("OTRA", variables)?.tone).toBe("warn");
    expect(notifyVariableHint("OTRA", undefined)).toBeNull();
  });
});
