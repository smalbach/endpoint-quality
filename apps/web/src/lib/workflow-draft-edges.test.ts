import { describe, expect, test } from "vitest";
import {
  addControlStep,
  connectStep,
  disconnectEdges,
  duplicateStep,
  flowNodeStartedAt,
  loopBodyIds,
  positionFor,
  predecessorFor,
  problemsWith,
  removeStep,
  replaceStep,
  rerunPathIds,
  schemaJsonProblem,
  suggestCaptures,
  toEdges,
  toNodes,
  variablesFor,
} from "@/lib/workflow-draft";
import type { WorkflowStepView } from "@/lib/types";

/** The edge cases the main suite walks past: nodes with nothing configured yet, and the wires that
 * reach into every kind of control node. */

describe("duplicar y quitar nodos, en los bordes", () => {
  test("duplicar un id que no existe no cambia nada", () => {
    const steps: WorkflowStepView[] = [{ id: "a" }];
    expect(duplicateStep(steps, "nope")).toBe(steps);
  });

  test("un nodo sin posición se duplica cerca de donde caería", () => {
    const steps: WorkflowStepView[] = [{ id: "a" }];
    const at = positionFor(1);
    expect(duplicateStep(steps, "a")[1].position).toEqual({ x: at.x + 48, y: at.y + 48 });
  });

  test("quitar el paso que leían un If, un bucle y un reintento les deja el `from` vacío", () => {
    const steps: WorkflowStepView[] = [
      { id: "src" },
      { id: "keep" },
      {
        id: "rama",
        kind: "branch",
        dependsOn: ["src"],
        condition: { from: "src", check: { source: "status", operator: "equals", value: "200" } },
      },
      { id: "bucle", kind: "loop", dependsOn: ["src"], loop: { from: "src", path: "data", as: "item", max: 5 } },
      { id: "r1", kind: "retry", rerun: { from: "src", target: "keep", attempts: 3, delayMs: 10 } },
      { id: "r2", kind: "retry", rerun: { from: "keep", target: "src", attempts: 3, delayMs: 10 } },
    ];
    const after = removeStep(steps, "src");
    expect(after.find((s) => s.id === "rama")).toEqual({
      id: "rama",
      kind: "branch",
      condition: { from: "", check: { source: "status", operator: "equals", value: "200" } },
    });
    expect(after.find((s) => s.id === "bucle")?.loop).toEqual({ from: "", path: "data", as: "item", max: 5 });
    expect(after.find((s) => s.id === "r1")?.rerun).toMatchObject({ from: "", target: "keep" });
    expect(after.find((s) => s.id === "r2")?.rerun).toMatchObject({ from: "keep", target: "" });
  });
});

describe("conectar en los bordes", () => {
  test("un bucle sin `from` lo toma del paso conectado, con sus valores por defecto", () => {
    const steps: WorkflowStepView[] = [{ id: "lista" }, { id: "bucle", kind: "loop" }];
    expect(connectStep(steps, "lista", "bucle")[1]).toEqual({
      id: "bucle",
      kind: "loop",
      dependsOn: ["lista"],
      loop: { path: "data", as: "item", max: 50, from: "lista" },
    });
  });

  test("un If sin `from` conserva la comprobación que ya tenía", () => {
    const check = { source: "status" as const, operator: "equals", value: "404" };
    const steps: WorkflowStepView[] = [{ id: "a" }, { id: "rama", kind: "branch", condition: { from: "", check } }];
    expect(connectStep(steps, "a", "rama")[1].condition).toEqual({ from: "a", check });
  });

  test("un script sin configurar recibe código vacío y el paso conectado", () => {
    const steps: WorkflowStepView[] = [{ id: "a" }, { id: "js", kind: "script" }];
    expect(connectStep(steps, "a", "js")[1].script).toEqual({ code: "", from: "a" });
  });
});

describe("schemaJsonProblem", () => {
  test("pide el esquema cuando falta", () => {
    expect(schemaJsonProblem(undefined)).toBe("Falta el JSON Schema.");
    expect(schemaJsonProblem("   ")).toBe("Falta el JSON Schema.");
  });

  test("rechaza lo que no es un objeto", () => {
    expect(schemaJsonProblem("[]")).toBe("El esquema tiene que ser un objeto JSON.");
    expect(schemaJsonProblem("null")).toBe("El esquema tiene que ser un objeto JSON.");
    expect(schemaJsonProblem("3")).toBe("El esquema tiene que ser un objeto JSON.");
  });

  test("encuentra `pattern` dentro de un array", () => {
    expect(schemaJsonProblem('{"allOf":[{"type":"string"},{"pattern":"^a"}]}')).toBe(
      "Un esquema propio no puede usar «pattern».",
    );
    expect(schemaJsonProblem('{"allOf":[{"type":"string"}],"properties":{"pattern":{"type":"string"}}}')).toBeNull();
  });
});

describe("cuerpos de bucle y caminos de reintento, en los bordes", () => {
  test("un nodo marcado dentro del bucle pero sin arista no es cuerpo", () => {
    expect(
      loopBodyIds(
        [
          { id: "bucle", kind: "loop" },
          { id: "x", inLoop: "bucle" },
        ],
        "bucle",
      ),
    ).toEqual([]);
  });

  test("un `from` que no existe no tiene camino", () => {
    expect(rerunPathIds([{ id: "a" }], "a", "ghost")).toBeNull();
  });
});

describe("addControlStep con un nodo de origen", () => {
  test("script y bucle leen el nodo del que cuelgan", () => {
    const base: WorkflowStepView[] = [{ id: "a", position: { x: 0, y: 0 } }];
    expect(addControlStep(base, "script", "a").steps[1].script).toEqual({ code: "", from: "a" });
    expect(addControlStep(base, "loop", "a").steps[1].loop).toEqual({ from: "a", path: "data", as: "item", max: 50 });
  });

  test("sin origen, cada uno llega con su `from` vacío", () => {
    expect(addControlStep([], "script").steps[0].script).toEqual({ code: "" });
    expect(addControlStep([], "loop").steps[0].loop?.from).toBe("");
    expect(addControlStep([], "schema").steps[0].schema?.from).toBe("");
    expect(addControlStep([], "retry").steps[0].rerun).toMatchObject({ from: "", target: "" });
    expect(addControlStep([], "poll").steps[0].poll?.from).toBe("");
    expect(addControlStep([], "validate").steps[0].validate).toEqual({ from: "" });
  });
});

describe("cortar aristas de un If, un bucle y una rama", () => {
  test("cortar la arista que alimenta limpia lo que se leía por ella", () => {
    const check = { source: "status" as const, operator: "equals", value: "200" };
    const steps: WorkflowStepView[] = [
      { id: "src" },
      { id: "rama", kind: "branch", dependsOn: ["src"], condition: { from: "src", check } },
      { id: "bucle", kind: "loop", dependsOn: ["src"], loop: { from: "src", path: "d", as: "i", max: 3 } },
      { id: "si", dependsOn: ["rama"], branch: { of: "rama", take: "then" } },
    ];
    const after = disconnectEdges(steps, [
      { source: "src", target: "rama" },
      { source: "src", target: "bucle" },
      { source: "rama", target: "si" },
    ]);
    expect(after[1]).toEqual({ id: "rama", kind: "branch", condition: { from: "", check } });
    expect(after[2].loop?.from).toBe("");
    expect(after[3]).toEqual({ id: "si" });
  });
});

describe("replaceStep", () => {
  test("cambia solo el nodo con el mismo id", () => {
    const steps: WorkflowStepView[] = [{ id: "a" }, { id: "b" }];
    const next = replaceStep(steps, { id: "b", waitMs: 5 });
    expect(next).toEqual([{ id: "a" }, { id: "b", waitMs: 5 }]);
    expect(next[0]).toBe(steps[0]);
  });
});

describe("toEdges", () => {
  test("la salida «no» de un If se etiqueta", () => {
    const edges = toEdges([
      { id: "rama", kind: "branch" },
      { id: "x", dependsOn: ["rama"], branch: { of: "rama", take: "else" } },
    ]);
    expect(edges).toEqual([expect.objectContaining({ id: "rama-x", sourceHandle: "else", label: "no" })]);
  });
});

describe("toNodes con nodos sin configurar", () => {
  const kinds = [
    "branch",
    "wait",
    "merge",
    "validate",
    "set",
    "script",
    "loop",
    "notify",
    "subflow",
    "schema",
    "channel",
    "webhook",
    "mock",
    "retry",
    "poll",
    "graphql",
    "fetch",
  ] as const;
  const bare: WorkflowStepView[] = [...kinds.map((kind) => ({ id: kind, kind })), { id: "req" }];
  const nodes = toNodes(bare, [], []);
  const data = (id: string) => nodes.find((node) => node.id === id)!.data;

  test("cada tipo cae en valores vacíos en lugar de romper", () => {
    expect(data("branch")).toEqual({ name: "branch", from: "", runStatus: undefined });
    expect(data("wait")).toMatchObject({ ms: 0, startedAt: undefined });
    expect(data("merge")).toMatchObject({ count: 0, any: false });
    expect(data("validate")).toMatchObject({ from: "", checks: 0, script: false });
    expect(data("set")).toMatchObject({ variables: [] });
    expect(data("script")).toEqual({ name: "script", from: "", lines: 0, runStatus: undefined });
    expect(data("loop")).toMatchObject({ from: "", path: "", as: "", max: 50, body: 0 });
    expect(data("notify")).toMatchObject({ channel: "slack", urlVariable: "", message: "", failsFlow: false });
    expect(data("subflow")).toMatchObject({ chosen: false, inputs: 0, outputs: 0 });
    expect(data("schema")).toMatchObject({ from: "", source: "custom", strict: false });
    expect(data("channel")).toMatchObject({
      chosen: false,
      channelName: null,
      protocol: null,
      missing: false,
      scripted: null,
      captures: 0,
    });
    expect(data("webhook")).toMatchObject({ method: "POST", checks: 0, captures: 0 });
    expect(data("mock")).toMatchObject({ status: 0, delayMs: 0, captures: 0, checks: 0 });
    expect(data("retry")).toMatchObject({ from: "", target: "", attempts: 0, delayMs: 0 });
    expect(data("poll")).toMatchObject({ from: "", attempts: 0, delayMs: 0, checks: 0 });
    expect(data("graphql")).toMatchObject({
      url: "",
      operationName: "",
      captures: 0,
      checks: 0,
      useSession: false,
      allowErrors: false,
    });
    expect(data("fetch")).toMatchObject({ method: "GET", url: "", captures: 0, checks: 0, useSession: false });
    expect(data("req")).toMatchObject({ name: "Prueba eliminada", method: "?", path: "?", captures: 0, checks: 0 });
  });

  test("un script cuenta sus líneas, y un canal sin lista de canales no se da por perdido", () => {
    const [script, channel] = toNodes(
      [
        { id: "js", kind: "script", script: { code: "  a()\nb()\n  ", from: "x" } },
        {
          id: "c",
          kind: "channel",
          channel: { ...addControlStep([], "channel").steps[0].channel!, channelId: "ch-1" },
        },
      ],
      [],
      [],
    );
    expect(script.data).toMatchObject({ from: "x", lines: 2 });
    expect(channel.data).toMatchObject({ chosen: true, channelName: null, protocol: null, missing: false });
  });
});

describe("flowNodeStartedAt en los bordes", () => {
  test("ignora casos ajenos a un flujo y se queda con el inicio más reciente", () => {
    expect(
      flowNodeStartedAt([
        { scenarioId: "suite:x", status: "running", startedAt: "2026-01-01T00:00:00Z" },
        { scenarioId: "workflow:f:a", status: "running", startedAt: "2026-01-01T00:00:05Z" },
        { scenarioId: "workflow:f:a#1", status: "running", startedAt: "2026-01-01T00:00:01Z" },
      ]),
    ).toEqual({ a: "2026-01-01T00:00:05Z" });
  });
});

describe("suggestCaptures en los bordes", () => {
  test("una raíz que es array baja por su primer elemento, e índices solos dan nombre con guiones bajos", () => {
    expect(suggestCaptures([[7]])).toEqual([{ variable: "0_0", from: "body", path: "0.0" }]);
  });

  test("números y booleanos son capturas; undefined no; un camino repetido cuenta una vez", () => {
    expect(suggestCaptures({ n: 1, ok: true, nada: undefined, "a.b": "x", a: { b: "y" } })).toEqual([
      { variable: "n", from: "body", path: "n" },
      { variable: "ok", from: "body", path: "ok" },
      { variable: "b", from: "body", path: "a.b" },
    ]);
  });

  test("no baja más de cinco niveles", () => {
    expect(suggestCaptures({ a: { b: { c: { d: { e: 1, f: { g: 2 } } } } } })).toEqual([
      { variable: "e", from: "body", path: "a.b.c.d.e" },
    ]);
  });
});

describe("predecessorFor y variablesFor en los bordes", () => {
  test("un id que no existe no tiene predecesor", () => {
    expect(predecessorFor([{ id: "a" }], "nope")).toBeUndefined();
  });

  test("sin posiciones, se queda con el último candidato", () => {
    expect(predecessorFor([{ id: "a" }, { id: "b" }, { id: "c" }], "a")).toBe("c");
  });

  test("un nodo sin posición entre candidatos con posición cuenta como x=0", () => {
    expect(
      predecessorFor(
        [{ id: "a" }, { id: "b", position: { x: -10, y: 0 } }, { id: "t", position: { x: 100, y: 0 } }],
        "t",
      ),
    ).toBe("a");
  });

  test("una dependencia que no existe no aporta variables", () => {
    expect(variablesFor([{ id: "x", dependsOn: ["ghost"] }], "x", ["env"])[0]).toBe("env");
    expect(variablesFor([{ id: "x", dependsOn: ["ghost"] }], "x", [])).not.toContain("ghost");
  });
});

describe("flowProblems en los bordes", () => {
  test("ids repetidos", () => {
    expect(problemsWith([{ id: "a" }, { id: "a" }])).toContain("Hay pasos con el mismo id.");
  });

  test("nodos de control sin configurar", () => {
    const problems = problemsWith([
      { id: "rama", kind: "branch" },
      { id: "val", kind: "validate" },
      { id: "espera", kind: "wait" },
      { id: "vars", kind: "set" },
      { id: "vacio", kind: "set", set: { assignments: [] } },
      { id: "bucle", kind: "loop" },
      { id: "login", kind: "login" },
    ]);
    expect(problems).toEqual(
      expect.arrayContaining([
        "El nodo «rama» (If) no está conectado a ningún paso que leer.",
        "La validación «val» no está conectada a ningún paso que leer.",
        "La validación «val» no comprueba nada: añade una comprobación o un script.",
        "El nodo de espera «espera» no tiene un tiempo.",
        "El nodo set «vars» no asigna ninguna variable.",
        "El nodo set «vacio» no asigna ninguna variable.",
        "El bucle «bucle» no está conectado a ningún paso con una lista.",
        "El login «login» no dice de dónde sale la credencial.",
      ]),
    );
  });

  test("un bucle dentro de otro, y un forEach dentro de un bucle", () => {
    const problems = problemsWith([
      { id: "lista" },
      { id: "fuera", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "d", as: "i", max: 5 } },
      {
        id: "dentro",
        kind: "loop",
        dependsOn: ["fuera"],
        inLoop: "fuera",
        loop: { from: "fuera", path: "d", as: "j", max: 5 },
      },
      { id: "cada", dependsOn: ["fuera"], inLoop: "fuera", forEach: { from: "lista", path: "data", as: "k" } },
    ]);
    expect(problems).toContain("El bucle «dentro» está dentro de «fuera»: no se pueden anidar.");
    expect(problems).toContain("«cada» está dentro del bucle «fuera» y tiene su propio forEach.");
  });

  test("un sondeo sin comprobaciones", () => {
    expect(
      problemsWith([
        { id: "a" },
        { id: "s", kind: "poll", dependsOn: ["a"], poll: { from: "a", attempts: 3, delayMs: 1 } },
      ]),
    ).toEqual(["El sondeo «s» no tiene comprobaciones: nada dice cuándo parar."]);
  });

  describe("reintentos", () => {
    const retry = (id: string, from: string, target: string, dependsOn = from ? [from] : []): WorkflowStepView => ({
      id,
      kind: "retry",
      dependsOn,
      rerun: { from, target, attempts: 3, delayMs: 10 },
    });

    test("sin conectar ni salida", () => {
      expect(problemsWith([retry("r", "", "")])).toEqual([
        "El reintento «r» no está conectado a ningún paso que vigilar.",
        "El reintento «r» no tiene conectada su salida «reintentar»: arrástrala al nodo desde el que repetir.",
      ]);
    });

    test("vigilando un nodo que no falla solo", () => {
      expect(problemsWith([{ id: "w", kind: "wait", waitMs: 5 }, retry("r", "w", "w")])).toEqual([
        "El reintento «r» solo vigila una petición, un login, un fetch, GraphQL, una validación, un esquema o un script.",
      ]);
    });

    test("un camino que pasaría por un nodo que no se repite", () => {
      const problems = problemsWith([
        { id: "a" },
        { id: "s", kind: "subflow", dependsOn: ["a"], subflow: { workflowId: "f", inputs: [], outputs: [] } },
        { id: "b", dependsOn: ["s"] },
        retry("r", "b", "a"),
      ]);
      expect(problems).toEqual([
        "El reintento «r» pasaría por «s», que no se puede repetir (bucle, sub-flujo, sondeo, reintento o forEach).",
      ]);
    });

    test("un camino por un forEach tampoco se repite", () => {
      const problems = problemsWith([
        { id: "a", forEach: { from: "", path: "data", as: "k" } },
        { id: "b", dependsOn: ["a"] },
        retry("r", "b", "a"),
      ]);
      expect(problems).toEqual([
        "El reintento «r» pasaría por «a», que no se puede repetir (bucle, sub-flujo, sondeo, reintento o forEach).",
      ]);
    });

    test("conectado a más de un paso, y dos vigilando el mismo", () => {
      const problems = problemsWith([
        { id: "a" },
        { id: "b" },
        retry("r1", "a", "a", ["a", "b"]),
        retry("r2", "a", "a"),
      ]);
      expect(problems).toContain("El reintento «r1» solo se conecta al paso que vigila.");
      expect(problems).toContain("Hay más de un reintento vigilando «a».");
      expect(problems).toContain("Hay más de un reintento vigilando «a».");
      expect(problems.filter((p) => p === "Hay más de un reintento vigilando «a».")).toHaveLength(2);
    });

    test("dentro de un bucle", () => {
      const problems = problemsWith([
        { id: "lista" },
        { id: "bucle", kind: "loop", dependsOn: ["lista"], loop: { from: "lista", path: "d", as: "i", max: 5 } },
        { id: "a", dependsOn: ["bucle"], inLoop: "bucle" },
        retry("r", "a", "a"),
      ]);
      expect(problems).toContain("El reintento «r» está dentro de un bucle: no puede ir ahí.");
    });
  });
});

describe("los nodos ya configurados", () => {
  const check = { source: "status" as const, operator: "equals", value: "200" };

  test("conectar otro paso a un bucle que ya lee uno es una arista más, sin tocar su `from`", () => {
    const loop = { from: "a", path: "d", as: "i", max: 5 };
    const steps: WorkflowStepView[] = [{ id: "a" }, { id: "b" }, { id: "bucle", kind: "loop", dependsOn: ["a"], loop }];
    expect(connectStep(steps, "b", "bucle")[2]).toEqual({ id: "bucle", kind: "loop", dependsOn: ["a", "b"], loop });
  });

  test("un If sin condición recibe la comprobación por defecto", () => {
    expect(connectStep([{ id: "a" }, { id: "rama", kind: "branch" }], "a", "rama")[1].condition).toEqual({
      from: "a",
      check,
    });
  });

  test("la salida «sí» de un If se etiqueta", () => {
    expect(
      toEdges([
        { id: "rama", kind: "branch" },
        { id: "x", dependsOn: ["rama"], branch: { of: "rama", take: "then" } },
      ]),
    ).toEqual([expect.objectContaining({ sourceHandle: "then", label: "sí" })]);
  });

  test("toNodes cuenta lo que cada nodo trae", () => {
    const capture = { variable: "id", from: "body" as const, path: "id" };
    const nodes = toNodes(
      [
        { id: "rama", kind: "branch", condition: { from: "a", check } },
        { id: "val", kind: "validate", validate: { from: "a", script: "pm.test()" }, checks: [check] },
        {
          id: "canal",
          kind: "channel",
          channel: { ...addControlStep([], "channel").steps[0].channel!, messages: [] },
          captures: [capture],
        },
        {
          id: "hook",
          kind: "webhook",
          webhook: { timeoutMs: 1000, method: "PUT" },
          checks: [check],
          captures: [capture],
        },
        {
          id: "mock",
          kind: "mock",
          mock: { ...addControlStep([], "mock").steps[0].mock!, status: 201 },
          checks: [check],
          captures: [capture],
        },
        { id: "gql", kind: "graphql", graphql: { url: "u", query: "q" }, checks: [check], captures: [capture] },
        { id: "f", kind: "fetch", fetch: { method: "POST", url: "u" }, checks: [check], captures: [capture] },
        { id: "req", requestTemplateId: "gone", checks: [check], captures: [capture] },
      ],
      [],
      [],
    );
    const data = (id: string) => nodes.find((node) => node.id === id)!.data;
    expect(data("rama")).toMatchObject({ from: "a" });
    expect(data("val")).toMatchObject({ from: "a", checks: 1, script: true });
    expect(data("canal")).toMatchObject({ scripted: 0, captures: 1 });
    expect(data("hook")).toMatchObject({ timeoutMs: 1000, method: "PUT", checks: 1, captures: 1 });
    expect(data("mock")).toMatchObject({ status: 201, checks: 1, captures: 1 });
    expect(data("gql")).toMatchObject({ checks: 1, captures: 1 });
    expect(data("f")).toMatchObject({ method: "POST", checks: 1, captures: 1 });
    expect(data("req")).toMatchObject({ name: "Prueba eliminada", checks: 1, captures: 1 });
  });

  test("predecessorFor: candidatos sin posición cuentan como x=0 y empatan en orden del documento", () => {
    expect(predecessorFor([{ id: "a" }, { id: "b" }, { id: "t", position: { x: 100, y: 0 } }], "t")).toBe("a");
  });

  test("un If, una validación y un reintento bien conectados no tienen problemas", () => {
    expect(
      problemsWith([
        { id: "a" },
        { id: "rama", kind: "branch", dependsOn: ["a"], condition: { from: "a", check } },
        { id: "val", kind: "validate", dependsOn: ["a"], validate: { from: "a", script: "pm.test()" } },
        { id: "val2", kind: "validate", dependsOn: ["a"], validate: { from: "a" }, checks: [check] },
        { id: "r", kind: "retry", rerun: { from: "a", target: "a", attempts: 3, delayMs: 1 } },
      ]),
    ).toEqual([]);
  });
});
