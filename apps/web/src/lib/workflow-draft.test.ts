import { describe, expect, test } from "vitest";
import {
  addedNodeId,
  addControlStep,
  addBranchStep,
  addStep,
  applyPositions,
  connectStep,
  disconnectEdges,
  duplicateStep,
  flowNodeStatuses,
  freeSpot,
  mergeNodes,
  positionFor,
  predecessorFor,
  problemsWith,
  removeStep,
  suggestCaptures,
  templateUsage,
  toEdges,
  toNodes,
  uniqueName,
  uniqueTemplateName,
  variablesFor,
} from "@/lib/workflow-draft";
import type { RequestTemplateView, WorkflowStepView } from "@/lib/types";

const template = (id: string, name: string, operationId = "createThing"): RequestTemplateView => ({
  id,
  name,
  operationId,
  description: null,
  expectedStatus: 201,
  parameters: {},
  disabledParameters: {},
  headers: {},
  disabledHeaders: {},
  body: { type: "none" },
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

  test("duplicar un nodo copia su comportamiento con un id nuevo, desplazado y sin aristas", () => {
    const source: WorkflowStepView[] = [
      {
        id: "login",
        requestTemplateId: "t1",
        position: { x: 10, y: 20 },
        dependsOn: [],
        authorizes: { from: "body", path: "token" },
        captures: [{ variable: "id", from: "body", path: "data.id" }],
      },
      { id: "consultar", requestTemplateId: "t2", dependsOn: ["login"] },
    ];
    const next = duplicateStep(source, "login");
    expect(next).toHaveLength(3);
    const copy = next[2];
    expect(copy.id).toBe("login-2");
    expect(copy.requestTemplateId).toBe("t1");
    expect(copy.authorizes).toEqual({ from: "body", path: "token" });
    expect(copy.captures).toEqual([{ variable: "id", from: "body", path: "data.id" }]);
    // A duplicate is «another one», not «this wired in where that was»: no edges, offset so it does
    // not land on top of its source, and it never touches the steps that depended on the original.
    expect("dependsOn" in copy).toBe(false);
    expect(copy.position).toEqual({ x: 58, y: 68 });
    expect(next[1].dependsOn).toEqual(["login"]);
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

/**
 * Qué variables tiene sentido ofrecerle a un paso.
 *
 * Solo las de arriba, y por eso se recorre el grafo en vez de listar todas las capturas del flujo:
 * una variable que escribe un paso posterior —o uno que puede correr al lado— está vacía cuando
 * esta petición sale. Ofrecerla sería el editor sugiriendo el fallo, y el síntoma es un 404 que se
 * lee como un endpoint roto.
 */
describe("las capturas que sugiere una respuesta", () => {
  test("cada hoja escalar es un candidato, con id y token primero, y las listas entran por su primer elemento", () => {
    const body = {
      data: { id: 7, name: "pedido", items: [{ sku: "A1" }, { sku: "A2" }] },
      token: "abc",
      meta: { count: 2 },
    };
    const suggestions = suggestCaptures(body);
    const byPath = new Map(suggestions.map((suggestion) => [suggestion.path, suggestion]));
    // Los escalares están; el objeto y la lista no son capturas.
    expect(byPath.has("data.id")).toBe(true);
    expect(byPath.has("token")).toBe(true);
    expect(byPath.get("data.items.0.sku")?.variable).toBe("sku");
    expect(byPath.has("meta.count")).toBe(true);
    // Lo interesante (id, token) va delante de lo demás.
    const idRank = suggestions.findIndex((s) => s.path === "data.id");
    const countRank = suggestions.findIndex((s) => s.path === "meta.count");
    expect(idRank).toBeLessThan(countRank);
    // La variable sale del último segmento no numérico, y todo se lee del cuerpo.
    expect(byPath.get("data.id")?.variable).toBe("id");
    expect(suggestions.every((s) => s.from === "body")).toBe(true);
  });

  test("no repite un nombre que ya existe: lo desambigua", () => {
    const suggestions = suggestCaptures({ id: 1, nested: { id: 2 } }, ["id"]);
    const names = suggestions.map((s) => s.variable);
    // «id» ya está tomado, así que los dos candidatos llamados «id» se numeran sin chocar.
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("id");
  });
});

describe("las variables que un paso puede gastar", () => {
  const flow = (): WorkflowStepView[] => [
    { id: "login", requestTemplateId: "t0", captures: [{ variable: "token", from: "body", path: "data.token" }] },
    {
      id: "crear",
      requestTemplateId: "t1",
      dependsOn: ["login"],
      captures: [{ variable: "pedidoId", from: "body", path: "data.id" }],
    },
    { id: "leer", requestTemplateId: "t2", dependsOn: ["crear"] },
    { id: "aparte", requestTemplateId: "t3", captures: [{ variable: "otro", from: "body", path: "data.id" }] },
  ];

  /** Los valores computados van siempre al final y no dependen del flujo, así que lo que estas
   * pruebas miran es la parte de delante: los nombres que sí salen del entorno y de las capturas. */
  const namesFor = (stepId: string, environment: string[]) =>
    variablesFor(flow(), stepId, environment).filter((name) => !name.startsWith("$"));

  test("las del entorno valen para cualquier paso", () => {
    expect(namesFor("login", ["tenant"])).toEqual(["tenant"]);
  });

  test("las capturas llegan por la cadena entera, no solo del paso anterior", () => {
    expect(namesFor("leer", ["tenant"])).toEqual(["tenant", "pedidoId", "token"]);
  });

  test("los valores computados están siempre, porque no dependen de ningún entorno", () => {
    // `{{$uuid}}` funciona en un proyecto que nunca ha definido una variable, y no hay ninguna
    // pantalla que los liste: este menú es donde se descubren.
    expect(variablesFor(flow(), "login", [])).toContain("$uuid");
    expect(variablesFor(flow(), "login", [])).toContain("$hmacSha256:clave:texto");
  });

  test("y van los últimos: lo que alguien busca nueve de cada diez veces es una variable suya", () => {
    const all = variablesFor(flow(), "leer", ["tenant"]);
    expect(all.findIndex((name) => name.startsWith("$"))).toBe(3);
  });

  test("lo que captura un paso que no está arriba no se ofrece: estaría vacío al enviar", () => {
    expect(variablesFor(flow(), "leer", [])).not.toContain("otro");
  });

  test("un nombre repetido sale una vez: la captura pisa el valor del entorno, no convive con él", () => {
    expect(namesFor("leer", ["pedidoId"])).toEqual(["pedidoId", "token"]);
  });

  test("un ciclo a medio dibujar no cuelga el editor", () => {
    const cyclic: WorkflowStepView[] = [
      { id: "a", requestTemplateId: "t1", dependsOn: ["b"] },
      { id: "b", requestTemplateId: "t2", dependsOn: ["a"], captures: [{ variable: "x", from: "body", path: "d" }] },
    ];
    expect(variablesFor(cyclic, "a", []).filter((name) => !name.startsWith("$"))).toEqual(["x"]);
  });
});

describe("el estado de cada nodo durante una corrida", () => {
  test("saca el stepId del scenarioId, ignora suffix de fila/elemento y lo que no es de flujo", () => {
    const status = flowNodeStatuses([
      { scenarioId: "workflow:wf1:crear", status: "passed" },
      { scenarioId: "workflow:wf1:listar#0", status: "running" },
      { scenarioId: "matrix:algo", status: "failed" },
    ]);
    expect(status).toEqual({ crear: "passed", listar: "running" });
  });

  test("un paso con varios casos muestra el más relevante: running gana a todo, luego failed", () => {
    const running = flowNodeStatuses([
      { scenarioId: "workflow:wf:bucle#0", status: "passed" },
      { scenarioId: "workflow:wf:bucle#1", status: "running" },
      { scenarioId: "workflow:wf:bucle#2", status: "failed" },
    ]);
    expect(running.bucle).toBe("running");

    const failed = flowNodeStatuses([
      { scenarioId: "workflow:wf:bucle#0", status: "passed" },
      { scenarioId: "workflow:wf:bucle#1", status: "failed" },
      { scenarioId: "workflow:wf:bucle#2", status: "queued" },
    ]);
    expect(failed.bucle).toBe("failed");
  });
});

describe("cuántos nodos comparten una petición reutilizable", () => {
  const flows = [
    { id: "wf1", steps: [{ requestTemplateId: "t-leer" }, { requestTemplateId: "t-crear" }] },
    { id: "wf2", steps: [{ requestTemplateId: "t-leer" }] },
  ];

  test("cuenta el borrador actual más los demás flujos, sin duplicar el guardado del actual", () => {
    // El borrador de wf1 tiene dos nodos que usan t-leer; wf2 (otro flujo) uno. Total 3.
    const draft = [{ requestTemplateId: "t-leer" }, { requestTemplateId: "t-leer" }];
    expect(templateUsage(draft, flows, "wf1", "t-leer")).toBe(3);
  });

  test("una petición usada por un solo nodo no está compartida", () => {
    const draft = [{ requestTemplateId: "t-crear" }];
    expect(templateUsage(draft, flows, "wf1", "t-crear")).toBe(1);
  });
});

describe("el nombre de una copia independiente", () => {
  test("añade «(copia)» y evita chocar con el índice único", () => {
    expect(uniqueTemplateName("Leer widget", ["Leer widget"])).toBe("Leer widget (copia)");
    expect(uniqueTemplateName("Leer widget", ["Leer widget", "Leer widget (copia)"])).toBe("Leer widget (copia) 2");
  });

  test("no encadena «(copia) (copia)» al copiar una copia", () => {
    expect(uniqueTemplateName("Leer widget (copia)", ["Leer widget (copia)"])).toBe("Leer widget (copia) 2");
  });
});

describe("el nombre de una operación añadida al vuelo", () => {
  test("deja el nombre tal cual si está libre", () => {
    expect(uniqueName("GET /widgets", [])).toBe("GET /widgets");
  });

  test("sufija « 2», « 3»… al chocar, sin marcar «(copia)»", () => {
    expect(uniqueName("GET /widgets", ["GET /widgets"])).toBe("GET /widgets 2");
    expect(uniqueName("GET /widgets", ["GET /widgets", "GET /widgets 2"])).toBe("GET /widgets 3");
  });
});

describe("predecessorFor — a quién colgar una condición o un bucle", () => {
  const step = (id: string, x: number, dependsOn?: string[]): WorkflowStepView => ({
    id,
    requestTemplateId: `t-${id}`,
    position: { x, y: 0 },
    ...(dependsOn ? { dependsOn } : {}),
  });

  test("el nodo raíz no tiene predecesor", () => {
    const steps = [step("a", 0), step("b", 310, ["a"])];
    expect(predecessorFor(steps, "a")).toBeUndefined();
  });

  test("elige el nodo más a la izquierda del objetivo", () => {
    const steps = [step("a", 0), step("b", 310), step("c", 620)];
    expect(predecessorFor(steps, "c")).toBe("b");
  });

  test("nunca elige un descendiente: evita el ciclo", () => {
    // b depende de a; para a, b es descendiente y queda descartado aunque esté a su lado.
    const steps = [step("a", 310), step("b", 620, ["a"])];
    expect(predecessorFor(steps, "a")).toBeUndefined();
  });

  test("ignora a los que ya son dependencia", () => {
    const steps = [step("a", 0), step("b", 310), step("c", 620, ["b"])];
    // c ya depende de b; el otro candidato válido a su izquierda es a.
    expect(predecessorFor(steps, "c")).toBe("a");
  });
});

describe("nodos de bifurcación en el lienzo", () => {
  const flow = (): WorkflowStepView[] => [
    { id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } },
  ];

  test("addBranchStep suma un If que lee el paso, a su derecha", () => {
    const { steps, id } = addBranchStep(flow(), "crear");
    const branch = steps.find((step) => step.id === id)!;
    expect(branch.kind).toBe("branch");
    expect(branch.dependsOn).toEqual(["crear"]);
    expect(branch.condition?.from).toBe("crear");
    expect(branch.requestTemplateId).toBeUndefined();
    expect(branch.position).toEqual({ x: 350, y: 60 });
  });

  test("conectar desde un handle del If marca la rama del destino", () => {
    const { steps, id } = addBranchStep(flow(), "crear");
    const withLeer = [...steps, { id: "leer", requestTemplateId: "t2" } as WorkflowStepView];
    const wired = connectStep(withLeer, id, "leer", "then");
    const leer = wired.find((step) => step.id === "leer")!;
    expect(leer.dependsOn).toEqual([id]);
    expect(leer.branch).toEqual({ of: id, take: "then" });
  });

  test("conectar desde un nodo normal no marca rama alguna", () => {
    const wired = connectStep(
      [...flow(), { id: "leer", requestTemplateId: "t2" } as WorkflowStepView],
      "crear",
      "leer",
      "then",
    );
    expect(wired.find((step) => step.id === "leer")!.branch).toBeUndefined();
  });

  test("toEdges etiqueta la arista que sale de un handle del If", () => {
    const steps: WorkflowStepView[] = [
      { id: "crear", requestTemplateId: "t1" },
      { id: "rama", kind: "branch", dependsOn: ["crear"], condition: { from: "crear", check: { source: "status", operator: "equals", value: "200" } } },
      { id: "leer", requestTemplateId: "t2", dependsOn: ["rama"], branch: { of: "rama", take: "else" } },
    ];
    const edge = toEdges(steps).find((item) => item.target === "leer")!;
    expect(edge.sourceHandle).toBe("else");
    expect(edge.label).toBe("no");
  });

  test("borrar un If quita la rama que le colgaba", () => {
    const steps: WorkflowStepView[] = [
      { id: "crear", requestTemplateId: "t1" },
      { id: "rama", kind: "branch", dependsOn: ["crear"], condition: { from: "crear", check: { source: "status", operator: "equals", value: "200" } } },
      { id: "leer", requestTemplateId: "t2", dependsOn: ["rama"], branch: { of: "rama", take: "then" } },
    ];
    const leer = removeStep(steps, "rama").find((step) => step.id === "leer")!;
    expect(leer.branch).toBeUndefined();
    expect(leer.dependsOn ?? []).not.toContain("rama");
  });
});

describe("el nodo fetch", () => {
  const base: WorkflowStepView[] = [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];

  test("cae de la paleta con GET y sin URL, y el editor avisa hasta que la tenga", () => {
    const added = addControlStep(base, "fetch", "crear");
    const node = added.steps.find((step) => step.id === added.id)!;
    expect(node.kind).toBe("fetch");
    expect(node.fetch).toEqual({ method: "GET", url: "" });
    expect(node.dependsOn).toEqual(["crear"]);
    expect(node.requestTemplateId).toBeUndefined();
    expect(problemsWith(added.steps).some((message) => message.includes("no tiene URL"))).toBe(true);

    const withUrl = added.steps.map((step) =>
      step.id === added.id ? { ...step, fetch: { method: "POST" as const, url: "https://hooks.example.com/x" } } : step,
    );
    expect(problemsWith(withUrl)).toEqual([]);
  });

  test("se dibuja con su método y su URL, y sus capturas cuentan para los pasos siguientes", () => {
    const steps: WorkflowStepView[] = [
      {
        id: "fetch",
        kind: "fetch",
        fetch: { method: "DELETE", url: "/things/{{thingId}}", useSession: true },
        captures: [{ variable: "borrado", from: "body", path: "ok" }],
      },
      { id: "despues", requestTemplateId: "t1", dependsOn: ["fetch"] },
    ];
    const [node] = toNodes(steps, [], []);
    expect(node.type).toBe("fetch");
    expect(node.data).toMatchObject({ method: "DELETE", url: "/things/{{thingId}}", captures: 1, useSession: true });
    expect(variablesFor(steps, "despues", [])).toContain("borrado");
  });
});

describe("los nodos set y script", () => {
  const base: WorkflowStepView[] = [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];

  test("set cae con una fila vacía, avisa hasta tener nombre, y su variable llega a los siguientes", () => {
    const added = addControlStep(base, "set", "crear");
    const node = added.steps.find((step) => step.id === added.id)!;
    expect(node.set).toEqual({ assignments: [{ variable: "", value: "" }] });
    expect(problemsWith(added.steps).some((message) => message.includes("nombre de variable"))).toBe(true);

    const named = added.steps.map((step) =>
      step.id === added.id ? { ...step, set: { assignments: [{ variable: "total", value: "{{precio}}" }] } } : step,
    );
    expect(problemsWith(named)).toEqual([]);
    const next = [...named, { id: "usa", requestTemplateId: "t1", dependsOn: [added.id] }];
    expect(variablesFor(next, "usa", [])).toContain("total");
    expect(toNodes(named, [], []).find((item) => item.id === added.id)).toMatchObject({
      type: "set",
      data: { variables: ["total"] },
    });
  });

  test("script lee lo que se le conecta, y cortar la arista o borrar el paso lo olvida", () => {
    const loose = addControlStep(base, "script");
    const scriptId = loose.id;
    expect(loose.steps.find((step) => step.id === scriptId)!.script).toEqual({ code: "" });
    expect(problemsWith(loose.steps).some((message) => message.includes("no tiene código"))).toBe(true);

    const wired = connectStep(loose.steps, "crear", scriptId);
    expect(wired.find((step) => step.id === scriptId)!.script).toEqual({ code: "", from: "crear" });

    const cut = disconnectEdges(wired, [{ source: "crear", target: scriptId }]);
    expect(cut.find((step) => step.id === scriptId)!.script).toEqual({ code: "" });

    const removed = removeStep(wired, "crear");
    expect(removed.find((step) => step.id === scriptId)!.script).toEqual({ code: "" });
  });
});

describe("la paleta de nodos: soltar y conectar libre", () => {
  const flow = (): WorkflowStepView[] => [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];

  test("addControlStep suelta un nodo suelto con sus valores por defecto", () => {
    const wait = addControlStep(flow(), "wait");
    const waitNode = wait.steps.find((s) => s.id === wait.id)!;
    expect(waitNode.kind).toBe("wait");
    expect(waitNode.waitMs).toBe(1000);
    expect(waitNode.dependsOn).toBeUndefined();

    const merge = addControlStep(flow(), "merge");
    expect(merge.steps.find((s) => s.id === merge.id)!.waits).toBe("all");

    const validate = addControlStep(flow(), "validate");
    const v = validate.steps.find((s) => s.id === validate.id)!;
    expect(v.kind).toBe("validate");
    expect(v.validate?.from).toBe("");
    expect(v.checks?.length).toBe(1);
  });

  test("addControlStep con un nodo seleccionado lo cuelga de él", () => {
    const { steps, id } = addControlStep(flow(), "validate", "crear");
    const v = steps.find((s) => s.id === id)!;
    expect(v.dependsOn).toEqual(["crear"]);
    expect(v.validate?.from).toBe("crear");
    expect(v.position).toEqual({ x: 350, y: 60 });
  });

  test("conectar un paso a la entrada de un If suelto fija lo que lee", () => {
    const dropped = addControlStep(flow(), "branch").steps;
    const branchId = dropped.find((s) => s.kind === "branch")!.id;
    const wired = connectStep(dropped, "crear", branchId);
    const branch = wired.find((s) => s.id === branchId)!;
    expect(branch.dependsOn).toEqual(["crear"]);
    expect(branch.condition?.from).toBe("crear");
  });

  test("conectar un paso a la entrada de una validación suelta fija lo que lee", () => {
    const dropped = addControlStep(flow(), "validate").steps;
    const vId = dropped.find((s) => s.kind === "validate")!.id;
    const wired = connectStep(dropped, "crear", vId);
    expect(wired.find((s) => s.id === vId)!.validate?.from).toBe("crear");
  });

  test("cortar la arista de entrada de una validación borra lo que leía", () => {
    const dropped = addControlStep(flow(), "validate", "crear").steps;
    const vId = dropped.find((s) => s.kind === "validate")!.id;
    const cut = disconnectEdges(dropped, [{ source: "crear", target: vId }]);
    const v = cut.find((s) => s.id === vId)!;
    expect(v.validate?.from).toBe("");
    expect(v.dependsOn ?? []).not.toContain("crear");
  });

  test("borrar el paso que una validación leía deja su from vacío, no colgando", () => {
    const dropped = addControlStep(flow(), "validate", "crear").steps;
    const vId = dropped.find((s) => s.kind === "validate")!.id;
    const v = removeStep(dropped, "crear").find((s) => s.id === vId)!;
    expect(v.validate?.from).toBe("");
  });

  test("toNodes da a cada tipo su forma en el lienzo", () => {
    const steps: WorkflowStepView[] = [
      { id: "login", kind: "login", requestTemplateId: "t1", authorizes: { from: "body", path: "token" } },
      { id: "espera", kind: "wait", waitMs: 500 },
      { id: "union", kind: "merge", waits: "any", dependsOn: ["login"] },
      { id: "valida", kind: "validate", dependsOn: ["login"], validate: { from: "login" }, checks: [] },
    ];
    const byId = Object.fromEntries(toNodes(steps, [template("t1", "Entrar")], []).map((n) => [n.id, n.type]));
    expect(byId).toEqual({ login: "login", espera: "wait", union: "merge", valida: "validate" });
  });
});

describe("addedNodeId — a qué nodo llevar la vista tras añadirlo", () => {
  test("el nodo nuevo, cuando el documento gana uno", () => {
    expect(addedNodeId(["salud", "crear"], ["salud", "crear", "if"])).toBe("if");
  });

  test("también en un flujo vacío", () => {
    expect(addedNodeId([], ["espera"])).toBe("espera");
  });

  test("nada si no hay con qué comparar (primer render o flujo recién abierto)", () => {
    expect(addedNodeId(undefined, ["salud", "crear"])).toBeUndefined();
  });

  test("nada si solo se movió o se quitó un nodo", () => {
    expect(addedNodeId(["salud", "crear"], ["salud", "crear"])).toBeUndefined();
    expect(addedNodeId(["salud", "crear"], ["salud"])).toBeUndefined();
  });

  test("nada si llega un documento entero de golpe", () => {
    expect(addedNodeId([], ["a", "b", "c"])).toBeUndefined();
  });
});

describe("freeSpot — un nodo nuevo no cae encima de otro", () => {
  test("dos If colgados del mismo nodo no se apilan", () => {
    const flow: WorkflowStepView[] = [{ id: "crear", requestTemplateId: "t1", position: { x: 40, y: 60 } }];
    const first = addControlStep(flow, "branch", "crear");
    const second = addControlStep(first.steps, "branch", "crear");
    const [a, b] = second.steps.slice(1).map((step) => step.position);
    expect(a).toEqual({ x: 350, y: 60 });
    expect(b).toEqual({ x: 350, y: 210 });
  });

  test("un sitio libre se queda como está", () => {
    expect(freeSpot([{ id: "a", requestTemplateId: "t1", position: { x: 0, y: 0 } }], { x: 400, y: 0 })).toEqual({ x: 400, y: 0 });
  });
});
