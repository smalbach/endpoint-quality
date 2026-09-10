import { describe, expect, test } from "vitest";
import {
  addStep,
  applyPositions,
  connectStep,
  disconnectEdges,
  positionFor,
  problemsWith,
  removeStep,
  toEdges,
  toNodes,
} from "@/lib/workflow-draft";
import type { RequestTemplateView, WorkflowStepView } from "@/lib/types";

const template = (id: string, name: string, operationId = "createThing"): RequestTemplateView => ({
  id,
  name,
  operationId,
  description: null,
  expectedStatus: 201,
  parameters: {},
  body: null,
  auth: "default",
  updatedAt: "2026-03-01T10:00:00.000Z",
});

const steps = (): WorkflowStepView[] => [
  { id: "crear", requestTemplateId: "t1", position: { x: 0, y: 0 } },
  { id: "consultar", requestTemplateId: "t2", dependsOn: ["crear"] },
];

describe("los pasos de un flujo", () => {
  test("añadir uno le da un id legible y un sitio en el lienzo", () => {
    const next = addStep([], template("t1", "Crear pedido"));
    expect(next[0].id).toBe("crear-pedido");
    expect(next[0].position).toEqual(positionFor(0));
    // Two of the same request are two nodes, so the second id cannot collide with the first.
    expect(addStep(next, template("t1", "Crear pedido"))[1].id).toBe("crear-pedido-2");
  });

  test("borrar un paso se lleva las aristas que apuntaban a él", () => {
    // The state this prevents — an edge pointing at a node that is gone — is the one the server
    // refuses, and it would refuse it naming an id nobody typed.
    const next = removeStep(steps(), "crear");
    expect(next).toHaveLength(1);
    expect(next[0].dependsOn).toBeUndefined();
  });

  test("conectar es idempotente y no admite un lazo sobre sí mismo", () => {
    const once = connectStep(steps(), "crear", "consultar");
    expect(once[1].dependsOn).toEqual(["crear"]);
    expect(connectStep(once, "crear", "crear")).toEqual(once);
  });

  test("desconectar deja el paso sin `dependsOn` en vez de con una lista vacía", () => {
    const next = disconnectEdges(steps(), [{ source: "crear", target: "consultar" }]);
    expect("dependsOn" in next[1]).toBe(false);
  });

  test("mover un nodo guarda su posición y no toca los demás", () => {
    const next = applyPositions(steps(), [{ id: "consultar", position: { x: 500, y: 120 } }]);
    expect(next[1].position).toEqual({ x: 500, y: 120 });
    expect(next[0].position).toEqual({ x: 0, y: 0 });
  });
});

describe("lo que se dibuja", () => {
  test("un nodo enseña el método y la ruta de la operación que su prueba nombra", () => {
    const nodes = toNodes(
      steps(),
      [template("t1", "Crear"), template("t2", "Leer", "getThing")],
      [
        { id: "createThing", method: "POST", path: "/things", summary: "" },
        { id: "getThing", method: "GET", path: "/things/{id}", summary: "" },
      ],
    );
    expect(nodes[0].data.method).toBe("POST");
    expect(nodes[1].data.path).toBe("/things/{id}");
  });

  test("un paso sin posición guardada cae en la rejilla en vez de no renderizar", () => {
    const nodes = toNodes([{ id: "a", requestTemplateId: "t1" }], [template("t1", "Crear")], []);
    expect(nodes[0].position).toEqual(positionFor(0));
  });

  test("una prueba borrada deja el nodo visible y dicho", () => {
    const nodes = toNodes([{ id: "a", requestTemplateId: "fantasma" }], [], []);
    expect(nodes[0].data.name).toBe("Prueba eliminada");
  });

  test("cada dependencia es una arista", () => {
    expect(toEdges(steps())).toEqual([{ id: "crear-consultar", source: "crear", target: "consultar", animated: true }]);
  });
});

describe("lo que el editor avisa antes de guardar", () => {
  test("un ciclo se nombra como tal", () => {
    const cyclic: WorkflowStepView[] = [
      { id: "a", requestTemplateId: "t1", dependsOn: ["b"] },
      { id: "b", requestTemplateId: "t2", dependsOn: ["a"] },
    ];
    expect(problemsWith(cyclic).some((problem) => problem.includes("ciclo"))).toBe(true);
  });

  test("una dependencia inexistente y una sobre sí mismo también", () => {
    expect(problemsWith([{ id: "a", requestTemplateId: "t1", dependsOn: ["a"] }])[0]).toContain("sí mismo");
    expect(problemsWith([{ id: "a", requestTemplateId: "t1", dependsOn: ["z"] }])[0]).toContain("no existe");
  });

  test("un grafo sano no dice nada", () => {
    expect(problemsWith(steps())).toEqual([]);
  });
});
