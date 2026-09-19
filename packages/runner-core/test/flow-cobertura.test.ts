/**
 * Los bordes de los flujos que `flow.test.ts` no recorre.
 *
 * Aquel fichero prueba el camino feliz de cada flujo contra un contrato completo. Este prueba lo
 * que pasa cuando al contrato o a la respuesta les falta algo —no hay POST que prepare, la
 * creación no trae id, el caso entre roles no tiene nada que crear— y la regla es siempre la
 * misma: el flujo se detiene en vez de inventar un paso que no diría nada.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { defineProjectConfig } from "../src/config.ts";
import { resolveOperations } from "../src/scenarios.ts";
import { persistenceAssertion, planFlow, type StepOutcome, type StepRequest } from "../src/flow.ts";
import type { ActualResponse } from "../src/assertions.ts";
import type { Operation, ResolvedOperation, TestScenario } from "../src/types.ts";

const op = (id: string, method: Operation["method"], path: string, statuses: number[]): Operation => ({
  id,
  method,
  path,
  summary: "",
  tag: "W",
  statuses,
  parameters: [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
});

const operations: Operation[] = [
  // Sin plantilla de body y sin 201: la preparación tiene que esperar el 200 y no mandar nada.
  op("createWidget", "POST", "/widgets", [200, 422]),
  op("getWidget", "GET", "/widgets/{widget_id}", [200, 404]),
  op("replaceWidget", "PUT", "/widgets/{widget_id}", [200, 404]),
  op("deleteWidget", "DELETE", "/widgets/{widget_id}", [204, 404]),
  // Una mutación sin colección que la cree.
  op("replaceOrphan", "PUT", "/orphans/{orphan_id}", [200]),
  op("getOrphan", "GET", "/orphans/{orphan_id}", [200]),
  // Un POST cuya colección no tiene detalle, y otro cuyo detalle tiene un placeholder vacío.
  op("createLonely", "POST", "/lonely", [201]),
  op("createBroken", "POST", "/broken", [201]),
  op("getBroken", "GET", "/broken/{}", [200]),
  // Un PUT sin DELETE, para el caso entre roles sin limpieza.
  op("replaceGadget", "PUT", "/gadgets/{gadget_id}", [200]),
];

const config = defineProjectConfig({
  bodyTemplates: { replaceWidget: { body: { name: "otro" } }, replaceGadget: { body: { name: "g" } } },
  envelope: { rules: [], fallbackShape: "{ data: Resource }", errorShape: "ProblemDetails" },
});
const resolved = resolveOperations(operations, config);
const find = (id: string) => resolved.find((operation) => operation.id === id)!;

const scenario = (over: Partial<TestScenario>): TestScenario => ({
  id: "caso",
  name: "El caso",
  description: "",
  expectedStatus: 200,
  flow: "request",
  ...over,
});

const created = (body: unknown = { data: { widget_id: "w-9", orphan_id: "o-9", gadget_id: "g-9" } }): ActualResponse => ({
  status: 201,
  statusText: "Created",
  contentType: "application/json",
  headers: {},
  body,
  raw: "{}",
});

function walk(
  operation: ResolvedOperation,
  testScenario: TestScenario,
  answer: (step: StepRequest) => Partial<StepOutcome> = () => ({}),
  all: ResolvedOperation[] = resolved,
): StepRequest[] {
  const flow = planFlow({ operation, scenario: testScenario, config, operations: all, samples: 1 });
  const steps: StepRequest[] = [];
  let cursor = flow.next();
  while (!cursor.done) {
    steps.push(cursor.value);
    const canned = answer(cursor.value);
    cursor = flow.next({
      request: cursor.value,
      actual: canned.actual === undefined ? created() : canned.actual,
      ok: canned.ok ?? true,
      assertions: [],
    });
  }
  return steps;
}

describe("un solo request", () => {
  test("lleva el payload y las cabeceras de la petición guardada, y nada de parámetros si no hay", () => {
    const [only] = walk(
      find("createWidget"),
      scenario({
        payload: { type: "raw", text: "<w/>", contentType: "application/xml" },
        headers: { "content-type": "application/xml" },
      }),
    );
    assert.deepEqual(only.payload, { type: "raw", text: "<w/>", contentType: "application/xml" });
    assert.deepEqual(only.headers, { "content-type": "application/xml" });
    assert.equal(only.body, undefined);
    assert.equal(only.requestPath, "/widgets");
  });

  test("sin payload ni cabeceras el paso no inventa ninguna", () => {
    const [only] = walk(find("getWidget"), scenario({ parameters: { widget_id: "7" } }));
    assert.equal("payload" in only, false);
    assert.equal("headers" in only, false);
    assert.equal(only.requestPath, "/widgets/7");
  });

  test("una operación que no está en la lista del contrato se resuelve con la del propio caso", () => {
    // El editor puede planear un paso sobre una operación que todavía no se ha guardado en el
    // contrato; la ruta y la forma esperada salen de la operación que el caso trae.
    const [only] = walk(find("getWidget"), scenario({ parameters: { widget_id: "3" } }), () => ({}), []);
    assert.equal(only.requestPath, "/widgets/3");
    assert.equal(only.expectedShape, "{ data: Resource }");
  });
});

describe("entre roles, cuando falta algo", () => {
  const crossRole = (over: Partial<TestScenario> = {}): TestScenario =>
    scenario({
      flow: "cross-role",
      expectedStatus: 403,
      auth: "role:vendedor",
      prepare: { operationId: "createWidget", auth: "role:comprador" },
      ...over,
    });

  test("si la operación que prepara no existe en el contrato, no hay nada que pedir", () => {
    const steps = walk(find("getWidget"), crossRole({ prepare: { operationId: "noExiste", auth: "role:comprador" } }));
    assert.deepEqual(steps, []);
  });

  test("si la operación del caso no tiene identificador en la ruta, tampoco", () => {
    assert.deepEqual(walk(find("createWidget"), crossRole()), []);
  });

  test("sin preparación declarada no se crea nada", () => {
    const { prepare: _omitted, ...withoutPrepare } = crossRole();
    assert.deepEqual(walk(find("getWidget"), withoutPrepare), []);
  });

  test("una creación sin body ni 201 declarado espera el 200 y no manda cuerpo", () => {
    const [prepare] = walk(find("getWidget"), crossRole());
    assert.equal(prepare.purpose, "prepare");
    assert.equal(prepare.expectedStatus, 200);
    assert.equal(prepare.body, undefined);
  });

  test("si el dueño no es un rol, la etiqueta de la preparación no nombra a nadie", () => {
    const [prepare] = walk(
      find("getWidget"),
      crossRole({ prepare: { operationId: "createWidget", auth: "default" } }),
    );
    assert.equal(prepare.auth, "default");
    assert.doesNotMatch(prepare.label, /comprador/);
  });

  test("una escritura ajena manda su body y acepta también los códigos alternativos", () => {
    const steps = walk(
      find("replaceWidget"),
      crossRole({ alsoAccepted: [404], prepare: { operationId: "createWidget", auth: "role:comprador" } }),
    );
    const act = steps.find((step) => step.purpose === "act")!;
    assert.deepEqual(act.body, { name: "otro" });
    assert.deepEqual(act.alsoAccepted, [404]);
    assert.equal(act.requestPath, "/widgets/w-9");
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act", "cleanup"],
    );
  });

  test("una lectura ajena no manda body aunque la operación tenga uno", () => {
    const withBody = { ...find("getWidget"), body: { ignorado: true } };
    const act = walk(withBody, crossRole()).find((step) => step.purpose === "act")!;
    assert.equal(act.body, undefined);
    assert.equal(act.alsoAccepted, undefined);
  });

  test("sin DELETE en el contrato no hay limpieza", () => {
    const steps = walk(
      find("replaceGadget"),
      crossRole({ prepare: { operationId: "createWidget", auth: "role:comprador" } }),
    );
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act"],
    );
  });

  test("si la creación contesta sin cuerpo que leer, el flujo se detiene", () => {
    const steps = walk(find("getWidget"), crossRole(), () => ({ actual: null }));
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare"],
    );
  });
});

describe("create-read, cuando no hay dónde releer", () => {
  test("una colección sin detalle se queda en el POST", () => {
    const steps = walk(find("createLonely"), scenario({ flow: "create-read", expectedStatus: 201 }));
    assert.deepEqual(
      steps.map((step) => `${step.purpose}:${step.method}`),
      ["act:POST"],
    );
  });

  test("un detalle con un placeholder vacío no tiene identificador y tampoco se relee", () => {
    const steps = walk(find("createBroken"), scenario({ flow: "create-read", expectedStatus: 201 }));
    assert.equal(steps.length, 1);
  });

  test("si el POST contesta sin cuerpo, no hay id que perseguir", () => {
    const steps = walk(find("createLonely"), scenario({ flow: "create-read", expectedStatus: 201 }), () => ({
      actual: null,
    }));
    assert.equal(steps.length, 1);
  });
});

describe("mutaciones sobre una entidad propia", () => {
  test("sin POST que la cree, la mutación va sola y no toca ninguna semilla con preparación", () => {
    const steps = walk(find("replaceOrphan"), scenario({ flow: "replace-read", body: { name: "x" } }));
    assert.deepEqual(
      steps.map((step) => `${step.purpose}:${step.method}`),
      ["act:PUT"],
    );
  });

  test("una creación sin body ni 201 declarado prepara con un 200 y sin cuerpo", () => {
    const steps = walk(find("replaceWidget"), scenario({ flow: "replace-read", body: { name: "x" } }));
    assert.equal(steps[0].purpose, "prepare");
    assert.equal(steps[0].expectedStatus, 200);
    assert.equal(steps[0].body, undefined);
  });

  test("si la preparación no devuelve id, no se muta nada", () => {
    const steps = walk(find("replaceWidget"), scenario({ flow: "replace-read" }), () => ({
      actual: created({ data: {} }),
    }));
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare"],
    );
  });

  test("si la preparación contesta sin respuesta, tampoco", () => {
    const steps = walk(find("replaceWidget"), scenario({ flow: "replace-read" }), () => ({ actual: null }));
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare"],
    );
  });

  test("un reemplazo sin body manda un objeto vacío", () => {
    const steps = walk(find("replaceWidget"), scenario({ flow: "replace-read" }));
    const act = steps.find((step) => step.purpose === "act")!;
    assert.deepEqual(act.body, {});
  });

  test("si la mutación contesta sin cuerpo no se relee, pero se limpia", () => {
    const steps = walk(find("replaceWidget"), scenario({ flow: "replace-read" }), (step) =>
      step.purpose === "act" ? { actual: null } : {},
    );
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act", "cleanup"],
    );
  });

  test("sin DELETE el reemplazo relee y no limpia", () => {
    const steps = walk(find("replaceGadget"), scenario({ flow: "replace-read" }), () => ({}), [
      ...resolved,
      ...resolveOperations(
        [op("createGadget", "POST", "/gadgets", [201]), op("getGadget", "GET", "/gadgets/{gadget_id}", [200])],
        config,
      ),
    ]);
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act", "verify"],
    );
  });

  test("si el primer DELETE falla, deleted-read no relee ni borra otra vez", () => {
    const steps = walk(
      find("deleteWidget"),
      scenario({ flow: "deleted-read", expectedStatus: 204 }),
      (step) => (step.purpose === "act" ? { ok: false } : {}),
    );
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act"],
    );
  });

  test("deleted-read sin un DELETE aparte para repetir se queda en la relectura", () => {
    // El caso lo plantea la operación del caso; si el contrato no trae un DELETE en esa ruta
    // no hay segundo borrado que pedir.
    const withoutDelete = resolved.filter((operation) => operation.id !== "deleteWidget");
    const steps = walk(
      find("deleteWidget"),
      scenario({ flow: "deleted-read", expectedStatus: 204 }),
      () => ({}),
      withoutDelete,
    );
    assert.deepEqual(
      steps.map((step) => step.purpose),
      ["prepare", "act", "verify"],
    );
  });
});

describe("la aserción de persistencia", () => {
  const verify: StepRequest = {
    index: 1,
    purpose: "verify",
    label: "Comprobar el estado persistido",
    operationId: "getWidget",
    method: "GET",
    operationPath: "/widgets/{widget_id}",
    requestPath: "/widgets/w-9",
    expectedStatus: 200,
    expectedShape: "{ data: Resource }",
    auth: "default",
    samples: 1,
  };
  const read = (body: unknown): ActualResponse => ({
    status: 200,
    statusText: "OK",
    contentType: "application/json",
    headers: {},
    body,
    raw: "",
  });

  test("solo la lleva la relectura GET de algo que se envió", () => {
    assert.equal(persistenceAssertion({ ...verify, purpose: "act" }, read({}), { name: "x" }, "{ data: Resource }"), null);
    assert.equal(persistenceAssertion({ ...verify, method: "DELETE" }, read({}), { name: "x" }, "{ data: Resource }"), null);
    assert.equal(persistenceAssertion(verify, read({}), {}, "{ data: Resource }"), null);
  });

  test("lee el recurso dentro del envelope del proyecto", () => {
    const pass = persistenceAssertion(verify, read({ data: { name: "x" } }), { name: "x" }, " { data: Resource }");
    assert.equal(pass?.pass, true);
    const drift = persistenceAssertion(verify, read({ data: { name: "y" } }), { name: "x" }, "{ data: Resource }");
    assert.equal(drift?.pass, false);
    assert.match(drift!.detail, /No coinciden: name/);
  });

  test("con una forma sin clave, el recurso es el cuerpo entero", () => {
    const bare = persistenceAssertion(verify, read({ name: "x" }), { name: "x" }, "Resource");
    assert.equal(bare?.pass, true);
  });

  test("sin respuesta, o con una que no es un objeto, no hay recurso que comparar", () => {
    for (const actual of [null, read("texto"), read(null)]) {
      const verdict = persistenceAssertion(verify, actual, { name: "x" }, "{ data: Resource }");
      assert.equal(verdict?.pass, false);
      assert.equal(verdict?.detail, "La respuesta no contiene el recurso");
    }
  });
});
