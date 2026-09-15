import { describe, expect, test } from "vitest";
import { DEFAULT_GRAPHQL_QUERY, graphqlVariablesProblem } from "@/lib/graphql-draft";
import { addControlStep, CONTROL_PALETTE, problemsWith, toNodes } from "@/lib/workflow-draft";
import type { StepGraphqlView, WorkflowStepView } from "@/lib/types";

describe("el nodo GraphQL", () => {
  const base: WorkflowStepView[] = [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];
  const withCall = (steps: WorkflowStepView[], id: string, change: Partial<StepGraphqlView>) =>
    steps.map((step) => (step.id === id ? { ...step, graphql: { ...step.graphql!, ...change } } : step));

  test("está en la paleta y cae con una query que funciona, colgado del nodo elegido", () => {
    expect(CONTROL_PALETTE.find((item) => item.kind === "graphql")).toMatchObject({ glyph: "◈", label: "GraphQL" });
    const added = addControlStep(base, "graphql", "crear");
    const node = added.steps.find((step) => step.id === added.id)!;
    expect(added.id).toBe("graphql");
    expect(node).toMatchObject({ kind: "graphql", dependsOn: ["crear"], graphql: { url: "", query: DEFAULT_GRAPHQL_QUERY } });
  });

  test("avisa de la URL, la query, las variables y el operationName, y se dibuja como graphql", () => {
    const { steps, id } = addControlStep(base, "graphql", "crear");
    expect(problemsWith(steps).some((message) => message.includes("no tiene URL"))).toBe(true);

    const ready = withCall(steps, id, { url: "/graphql", variables: '{"id": "{{thingId}}", "n": {{count}}}', operationName: "Cosa" });
    expect(problemsWith(ready)).toEqual([]);
    expect(toNodes(ready, [], []).find((item) => item.id === id)).toMatchObject({
      type: "graphql",
      data: { url: "/graphql", operationName: "Cosa", useSession: false, allowErrors: false },
    });

    expect(problemsWith(withCall(ready, id, { query: "  " })).some((message) => message.includes("no tiene query"))).toBe(true);
    expect(problemsWith(withCall(ready, id, { variables: "[1]" })).some((message) => message.includes("objeto JSON"))).toBe(true);
    expect(problemsWith(withCall(ready, id, { variables: '{"a": ' })).some((message) => message.includes("no son JSON"))).toBe(true);
    expect(problemsWith(withCall(ready, id, { operationName: "no-vale" })).some((message) => message.includes("operationName"))).toBe(
      true,
    );
  });

  test("las variables se leen con las plantillas en lugar de los valores", () => {
    expect(graphqlVariablesProblem(undefined)).toBeNull();
    expect(graphqlVariablesProblem('{"s": "a \\"{{b}}\\" c", "n": {{n}}}')).toBeNull();
    expect(graphqlVariablesProblem("{{todo}}")).toMatch(/objeto/);
    expect(graphqlVariablesProblem('{"id": {{x}}')).toMatch(/no son JSON/);
  });
});
