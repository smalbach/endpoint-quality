import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";
import { MAX_SUBFLOW_DEPTH, subflowProblems, type SubflowTarget } from "../src/subflows.ts";
import type { WorkflowDocument } from "../src/workflows.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const req = (id: string, extra: Record<string, unknown> = {}) => ({ id, requestTemplateId: uuid(1), ...extra });
const sub = (id: string, workflowId: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "subflow",
  subflow: { workflowId },
  ...extra,
});
const calls = (...ids: string[]): WorkflowDocument => ({
  steps: ids.map((id, index) => ({ id: `s${index}`, kind: "subflow" as const, subflow: { workflowId: id } })),
});

describe("el nodo sub-flujo en el esquema", () => {
  const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;

  test("lleva un flujo por uuid, entradas con nombre de variable y salidas", () => {
    assert.equal(parse([sub("s", uuid(9))]), true);
    assert.equal(
      parse([req("a"), sub("s", uuid(9), { dependsOn: ["a"], subflow: { workflowId: uuid(9), inputs: [{ variable: "x", value: "{{y}}" }], outputs: ["id"] } })]),
      true,
    );
    assert.equal(parse([sub("s", "")]), false);
    assert.equal(parse([{ id: "s", kind: "subflow" }]), false);
    assert.equal(parse([sub("s", uuid(9), { subflow: { workflowId: uuid(9), inputs: [{ variable: "no vale", value: "" }] } })]), false);
    assert.equal(parse([sub("s", uuid(9), { subflow: { workflowId: uuid(9), outputs: ["1x"] } })]), false);
    assert.equal(parse([req("a", { subflow: { workflowId: uuid(9) } })]), false);
    assert.equal(
      parse([req("l"), sub("s", uuid(9), { dependsOn: ["l"], forEach: { from: "l", path: "data", as: "item" } })]),
      false,
    );
  });

  test("no puede ir dentro de un bucle", () => {
    const loop = { id: "b", kind: "loop", dependsOn: ["l"], loop: { from: "l", path: "data", as: "item" } };
    assert.equal(parse([req("l"), loop, sub("s", uuid(9), { dependsOn: ["b"] })]), true);
    assert.equal(parse([req("l"), loop, sub("s", uuid(9), { dependsOn: ["b"], inLoop: "b" })]), false);
  });

  test("sus salidas cuentan como escrituras que pueden chocar con un paso concurrente", () => {
    assert.equal(
      parse([req("a", { captures: [{ variable: "id", from: "body", path: "id" }] }), sub("s", uuid(9), { subflow: { workflowId: uuid(9), outputs: ["id"] } })]),
      false,
    );
  });
});

describe("subflowProblems", () => {
  const library = (flows: SubflowTarget[]) => {
    const byId = new Map(flows.map((flow) => [flow.id, flow]));
    return (id: string) => byId.get(id);
  };
  const flow = (n: number, definition: WorkflowDocument = { steps: [] }, status = "ready"): SubflowTarget => ({
    id: uuid(n),
    name: `F${n}`,
    status,
    definition,
  });

  test("un sub-flujo válido no tiene problemas; uno de otro proyecto o archivado sí", () => {
    const lookup = library([flow(2), flow(3, { steps: [] }, "archived")]);
    assert.deepEqual(subflowProblems({ id: uuid(1), definition: calls(uuid(2)) }, lookup), []);
    const problems = subflowProblems({ id: uuid(1), definition: calls(uuid(2), uuid(7), uuid(3)) }, lookup);
    assert.deepEqual(
      problems.map((problem) => [problem.stepIndex, problem.stepId]),
      [
        [1, "s1"],
        [2, "s2"],
      ],
    );
    assert.match(problems[0].detail, /no existe en este proyecto/);
    assert.match(problems[1].detail, /archivado/);
  });

  test("rechaza la autorreferencia y los ciclos entre flujos", () => {
    const self = subflowProblems({ id: uuid(1), name: "A", definition: calls(uuid(1)) }, library([]));
    assert.match(self[0].detail, /el flujo que lo contiene/);

    // A → B → A, visto al guardar A con su nueva definición.
    const cycle = subflowProblems(
      { id: uuid(1), name: "A", definition: calls(uuid(2)) },
      library([flow(2, calls(uuid(1)))]),
    );
    assert.equal(cycle.length, 1);
    assert.match(cycle[0].detail, /ciclo: «A» › «F2» › «A»/);

    // Un flujo nuevo no tiene id: nada puede cerrar un ciclo con él.
    assert.deepEqual(subflowProblems({ definition: calls(uuid(2)) }, library([flow(2)])), []);
  });

  test(`anida como mucho ${MAX_SUBFLOW_DEPTH} niveles`, () => {
    const chain = library([flow(2, calls(uuid(3))), flow(3, calls(uuid(4))), flow(4, calls(uuid(5))), flow(5)]);
    assert.deepEqual(subflowProblems({ id: uuid(1), definition: calls(uuid(3)) }, chain), []);
    const deep = subflowProblems({ id: uuid(1), definition: calls(uuid(2)) }, chain);
    assert.equal(deep.length, 1);
    assert.match(deep[0].detail, /más de 3 niveles/);
  });
});
