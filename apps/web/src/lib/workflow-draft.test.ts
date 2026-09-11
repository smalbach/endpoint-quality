import { describe, expect, test } from "vitest";
import {
  addStep,
  applyPositions,
  connectStep,
  disconnectEdges,
  mergeNodes,
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

/**
 * Lo que el lienzo conserva de un render al siguiente, y lo que no.
 *
 * React Flow guarda de cada nodo lo que **midió**, y uno que no ha medido se queda invisible: por
 * eso hay que conservar algo en vez de reconstruir el array. Lo que no se puede conservar es la
 * posición, que es del documento — y conservarla hacía que cambiar de flujo pintara el anterior,
 * en silencio, siempre que los dos compartieran el id de un paso. «salud», «crear» y «listar» son
 * los nombres que le pone cualquiera, así que dos flujos del mismo proyecto los comparten sin
 * proponérselo.
 */
describe("los nodos del lienzo, entre un documento y el siguiente", () => {
  const node = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
    id,
    position: { x, y },
    data: { name: id },
    ...extra,
  });

  test("la posición la manda el documento, no lo que había en el lienzo", () => {
    const current = [node("salud", 20, 40, { measured: { width: 256, height: 96 } })];
    const [merged] = mergeNodes(current, [node("salud", 340, 120)]);
    expect(merged.position).toEqual({ x: 340, y: 120 });
  });

  test("lo medido sí se conserva, que es para lo que existe la mezcla", () => {
    const current = [node("salud", 20, 40, { measured: { width: 256, height: 96 } })];
    const [merged] = mergeNodes(current, [node("salud", 340, 120)]);
    expect((merged as { measured?: unknown }).measured).toEqual({ width: 256, height: 96 });
  });

  test("un nodo que el documento ya no tiene desaparece", () => {
    const merged = mergeNodes([node("salud", 0, 0), node("viejo", 0, 0)], [node("salud", 10, 10)]);
    expect(merged.map((entry) => entry.id)).toEqual(["salud"]);
  });

  test("un nodo nuevo entra tal cual, sin medir", () => {
    const merged = mergeNodes([node("salud", 0, 0)], [node("salud", 0, 0), node("nuevo", 300, 0)]);
    expect(merged[1].position).toEqual({ x: 300, y: 0 });
  });

  test("cambiar de flujo no arrastra las posiciones del anterior", () => {
    // El caso real: dos flujos con los mismos ids, y el segundo pintado con las coordenadas del
    // primero. Se veía mal, y al arrastrar cualquier nodo escribía esas coordenadas ajenas en el
    // documento de este.
    const anterior = [node("salud", 20, 40), node("crear", 320, 40), node("listar", 620, 40)];
    const otro = [node("salud", 20, 40), node("listar", 20, 200), node("crear", 340, 120)];
    expect(mergeNodes(anterior, otro).map((entry) => entry.position)).toEqual([
      { x: 20, y: 40 },
      { x: 20, y: 200 },
      { x: 340, y: 120 },
    ]);
  });
});
