import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { applyCaptures, orderWorkflowSteps, withinBudget } from "../src/workflows.ts";
import { safeParseWorkflowDocument } from "../src/workflow-schema.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("orders workflow dependencies while preserving document order", () => {
  const steps = orderWorkflowSteps({
    steps: [
      { id: "read", requestTemplateId: uuid(1), dependsOn: ["update"] },
      { id: "update", requestTemplateId: uuid(2) },
    ],
  });
  assert.deepEqual(
    steps.map((step) => step.id),
    ["update", "read"],
  );
});

test("refuses to order a graph whose edge names a step that is not there", () => {
  assert.throws(
    () => orderWorkflowSteps({ steps: [{ id: "read", requestTemplateId: uuid(1), dependsOn: ["ausente"] }] }),
    /dependencias cíclicas o inexistentes/,
  );
});

test("captures response body and headers as runtime variables", () => {
  const variables = { base: "kept" };
  const result = applyCaptures(
    [
      { variable: "userId", from: "body", path: "data.id" },
      { variable: "cursor", from: "header", path: "x-cursor" },
    ],
    { body: { data: { id: 9 } }, headers: { "x-cursor": "next" } },
    variables,
  );
  assert.deepEqual(variables, { base: "kept", userId: "9", cursor: "next" });
  assert.deepEqual(result.missing, []);
});

test("a captured object is reported as missing, not stringified into a URL", () => {
  const variables: Record<string, string> = {};
  const result = applyCaptures(
    [{ variable: "user", from: "body", path: "data" }],
    { body: { data: { id: 9 } }, headers: {} },
    variables,
  );
  assert.deepEqual(result.missing, ["user"]);
  assert.deepEqual(variables, {});
});

test("rejects cycles, duplicate ids and self-dependency when the flow is saved", () => {
  const cyclic = safeParseWorkflowDocument({
    steps: [
      { id: "a", requestTemplateId: uuid(1), dependsOn: ["b"] },
      { id: "b", requestTemplateId: uuid(2), dependsOn: ["a"] },
    ],
  });
  assert.equal(cyclic.ok, false);
  if (!cyclic.ok) assert.ok(cyclic.issues.some((issue) => issue.detail.includes("cíclicas")));

  const duplicated = safeParseWorkflowDocument({
    steps: [
      { id: "a", requestTemplateId: uuid(1) },
      { id: "a", requestTemplateId: uuid(2) },
    ],
  });
  assert.equal(duplicated.ok, false);
  if (!duplicated.ok) assert.ok(duplicated.issues.some((issue) => issue.detail.includes("únicos")));

  const selfish = safeParseWorkflowDocument({ steps: [{ id: "a", requestTemplateId: uuid(1), dependsOn: ["a"] }] });
  assert.equal(selfish.ok, false);
  if (!selfish.ok) assert.ok(selfish.issues.some((issue) => issue.detail.includes("sí mismo")));
});

test("an edge to a step that does not exist names the offending id", () => {
  const dangling = safeParseWorkflowDocument({
    steps: [{ id: "a", requestTemplateId: uuid(1), dependsOn: ["fantasma"] }],
  });
  assert.equal(dangling.ok, false);
  if (!dangling.ok) {
    assert.ok(dangling.issues.some((issue) => issue.detail.includes("fantasma")));
    assert.ok(dangling.issues.some((issue) => issue.field === "steps.0.dependsOn"));
  }
});

test("canvas coordinates survive validation and a bad one is refused", () => {
  assert.equal(
    safeParseWorkflowDocument({ steps: [{ id: "a", requestTemplateId: uuid(1), position: { x: 40, y: 60 } }] }).ok,
    true,
  );
  assert.equal(
    safeParseWorkflowDocument({ steps: [{ id: "a", requestTemplateId: uuid(1), position: { x: "40", y: 60 } }] }).ok,
    false,
  );
});

/**
 * Los dos techos de un bucle, que dicen cosas distintas.
 *
 * `max` es el del autor y es parte del flujo. El presupuesto es el de la corrida: todos los topes
 * de este producto son locales —filas de datos, flujos de una suite, vueltas de un bucle— y se
 * multiplican, así que algo tiene que mirar el total, y el total solo se sabe recorriendo porque
 * la lista la decide el destino.
 */
describe("lo que un bucle puede recorrer", () => {
  const list = Array.from({ length: 10 }, (_item, index) => index);

  test("el tope del autor recorta primero", () => {
    assert.deepEqual(withinBudget(list, 3, 100), { elements: [0, 1, 2], dropped: 0 });
  });

  test("el presupuesto de la corrida recorta después, y lo dice", () => {
    // El caso del propio paso ya está contado, así que un bucle de N cuesta N-1 más.
    assert.deepEqual(withinBudget(list, 10, 4), { elements: [0, 1, 2, 3, 4], dropped: 5 });
  });

  test("un elemento nunca se recorta, ni sin presupuesto", () => {
    // Ese caso ya estaba contado antes de saber que había un bucle: recortarlo dejaría el paso sin
    // ejecutar y sin veredicto.
    assert.deepEqual(withinBudget([7], 10, 0), { elements: [7], dropped: 0 });
    assert.deepEqual(withinBudget([], 10, 0), { elements: [], dropped: 0 });
  });

  test("un presupuesto negativo se trata como cero, no como un recorte al revés", () => {
    assert.deepEqual(withinBudget(list, 10, -5), { elements: [0], dropped: 9 });
  });
});

/**
 * De dónde se saca un valor de una respuesta.
 *
 * Las dos primeras rutas —cuerpo y cabecera— son para una API pensada para que la lea un programa.
 * Las otras dos existen porque muchas no lo están: una sesión llega en un `Set-Cookie`, del que la
 * cabecera entera trae atributos y fechas, y a veces el valor está incrustado dentro de un texto
 * que diseñó otro.
 */
describe("las cuatro rutas de una captura", () => {
  const response = {
    body: { data: { id: "42" } },
    headers: {
      "x-total": "3",
      "set-cookie": "session=abc123; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT; HttpOnly, theme=oscuro; Path=/",
    },
    raw: "id del pedido: PED-99 (creado)",
  };
  const capture = (from: "body" | "header" | "cookie" | "regex", path: string) => {
    const variables: Record<string, string> = {};
    const result = applyCaptures([{ variable: "v", from, path }], response, variables);
    return { value: variables.v, ...result };
  };

  test("una ruta con puntos entra en el cuerpo", () => {
    assert.equal(capture("body", "data.id").value, "42");
  });

  test("una cabecera se encuentra escrita como sea", () => {
    assert.equal(capture("header", "X-Total").value, "3");
  });

  test("una cookie sale de su directiva, sin los atributos", () => {
    // La cabecera entera es `session=abc123; Path=/; Expires=…`. Sacar eso con una ruta de puntos
    // no es algo que se le pueda pedir a nadie.
    assert.equal(capture("cookie", "session").value, "abc123");
  });

  test("una fecha dentro de la cookie no parte la siguiente", () => {
    // `Expires=Wed, 09 Jun 2027` lleva una coma, y la coma es también lo que separa dos cookies.
    assert.equal(capture("cookie", "theme").value, "oscuro");
  });

  test("una cookie que no está se informa como que falta, no como vacía", () => {
    assert.deepEqual(capture("cookie", "noExiste").missing, ["v"]);
  });

  test("una expresión regular se aplica al texto crudo y devuelve su grupo", () => {
    assert.equal(capture("regex", "pedido: (PED-\\d+)").value, "PED-99");
  });

  test("sin grupo, la coincidencia entera", () => {
    assert.equal(capture("regex", "PED-\\d+").value, "PED-99");
  });

  test("una expresión rota no tumba la corrida: se informa como que falta", () => {
    assert.deepEqual(capture("regex", "(").missing, ["v"]);
  });
});
