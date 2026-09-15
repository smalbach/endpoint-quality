import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { applyCaptures, loopBody, orderWorkflowSteps, rerunPath, withinBudget, type WorkflowStep } from "../src/workflows.ts";
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

describe("nodos de bifurcación (If con sí/no)", () => {
  const requestNode = (id: string, extra: object = {}) => ({ id, requestTemplateId: uuid(1), ...extra });
  const branchNode = (id: string, from: string, extra: object = {}) => ({
    id,
    kind: "branch",
    condition: { from, check: { source: "status", operator: "equals", value: "200" } },
    dependsOn: [from],
    ...extra,
  });

  test("un If válido con una rama sí se acepta", () => {
    const doc = safeParseWorkflowDocument({
      steps: [
        requestNode("crear"),
        branchNode("si-creo", "crear"),
        requestNode("leer", { dependsOn: ["si-creo"], branch: { of: "si-creo", take: "then" } }),
      ],
    });
    assert.equal(doc.ok, true);
  });

  test("un nodo de bifurcación sin condición se rechaza", () => {
    const doc = safeParseWorkflowDocument({
      steps: [requestNode("crear"), { id: "bif", kind: "branch", dependsOn: ["crear"] }],
    });
    assert.equal(doc.ok, false);
    if (!doc.ok) assert.ok(doc.issues.some((issue) => issue.detail.includes("necesita una condición")));
  });

  test("un nodo de bifurcación no puede llevar petición", () => {
    const doc = safeParseWorkflowDocument({
      steps: [requestNode("crear"), branchNode("bif", "crear", { requestTemplateId: uuid(2) })],
    });
    assert.equal(doc.ok, false);
    if (!doc.ok) assert.ok(doc.issues.some((issue) => issue.detail.includes("no envía ninguna petición")));
  });

  test("un paso de petición sin petición se rechaza", () => {
    const doc = safeParseWorkflowDocument({ steps: [{ id: "a" }] });
    assert.equal(doc.ok, false);
    if (!doc.ok) assert.ok(doc.issues.some((issue) => issue.detail.includes("necesita una petición")));
  });

  test("una rama solo cuelga de un nodo de bifurcación, y del que depende", () => {
    const notBranch = safeParseWorkflowDocument({
      steps: [requestNode("crear"), requestNode("leer", { dependsOn: ["crear"], branch: { of: "crear", take: "then" } })],
    });
    assert.equal(notBranch.ok, false);
    if (!notBranch.ok) assert.ok(notBranch.issues.some((issue) => issue.detail.includes("nodo de bifurcación")));

    const notDependency = safeParseWorkflowDocument({
      steps: [requestNode("crear"), branchNode("bif", "crear"), requestNode("suelto", { branch: { of: "bif", take: "else" } })],
    });
    assert.equal(notDependency.ok, false);
    if (!notDependency.ok) assert.ok(notDependency.issues.some((issue) => issue.detail.includes("debe depender de su bifurcación")));
  });
});

describe("nodos de la paleta (login, espera, merge, validación)", () => {
  const req = (id: string, extra: object = {}) => ({ id, requestTemplateId: uuid(1), ...extra });
  const check = { source: "status", operator: "equals", value: "200" };

  test("un login válido lleva petición y de dónde sale la credencial", () => {
    const doc = safeParseWorkflowDocument({
      steps: [{ id: "login", kind: "login", requestTemplateId: uuid(1), authorizes: { from: "body", path: "token" } }],
    });
    assert.equal(doc.ok, true);
  });

  test("un login sin authorizes se rechaza", () => {
    const doc = safeParseWorkflowDocument({ steps: [{ id: "login", kind: "login", requestTemplateId: uuid(1) }] });
    assert.equal(doc.ok, false);
    if (!doc.ok) assert.ok(doc.issues.some((i) => i.detail.includes("de dónde sale la credencial")));
  });

  test("un nodo de espera necesita un tiempo y no lleva petición", () => {
    assert.equal(safeParseWorkflowDocument({ steps: [{ id: "w", kind: "wait", waitMs: 1000 }] }).ok, true);
    const sinTiempo = safeParseWorkflowDocument({ steps: [{ id: "w", kind: "wait" }] });
    assert.equal(sinTiempo.ok, false);
    if (!sinTiempo.ok) assert.ok(sinTiempo.issues.some((i) => i.detail.includes("milisegundos")));
    const conPeticion = safeParseWorkflowDocument({ steps: [{ id: "w", kind: "wait", waitMs: 10, requestTemplateId: uuid(1) }] });
    assert.equal(conPeticion.ok, false);
    if (!conPeticion.ok) assert.ok(conPeticion.issues.some((i) => i.detail.includes("no envía ninguna petición")));
  });

  test("un nodo merge une varias dependencias sin enviar petición", () => {
    const doc = safeParseWorkflowDocument({
      steps: [req("a"), req("b", { dependsOn: ["a"] }), { id: "m", kind: "merge", waits: "any", dependsOn: ["a", "b"] }],
    });
    assert.equal(doc.ok, true);
  });

  test("una validación lee un paso del que depende y asserta algo", () => {
    const conCheck = safeParseWorkflowDocument({
      steps: [req("crear"), { id: "v", kind: "validate", dependsOn: ["crear"], validate: { from: "crear" }, checks: [check] }],
    });
    assert.equal(conCheck.ok, true);

    const conScript = safeParseWorkflowDocument({
      steps: [
        req("crear"),
        { id: "v", kind: "validate", dependsOn: ["crear"], validate: { from: "crear", script: "pm.test('ok', () => {})" } },
      ],
    });
    assert.equal(conScript.ok, true);
  });

  test("una validación vacía (ni checks ni script) se rechaza", () => {
    const doc = safeParseWorkflowDocument({
      steps: [req("crear"), { id: "v", kind: "validate", dependsOn: ["crear"], validate: { from: "crear" } }],
    });
    assert.equal(doc.ok, false);
    if (!doc.ok) assert.ok(doc.issues.some((i) => i.detail.includes("al menos una comprobación o un script")));
  });

  test("una validación solo puede leer un paso del que depende", () => {
    const doc = safeParseWorkflowDocument({
      steps: [req("crear"), req("otro"), { id: "v", kind: "validate", dependsOn: ["otro"], validate: { from: "crear" }, checks: [check] }],
    });
    assert.equal(doc.ok, false);
    if (!doc.ok) assert.ok(doc.issues.some((i) => i.detail.includes("solo puede leer un paso")));
  });

  test("un fetch lleva su método y su URL, y ninguna petición guardada", () => {
    const valido = safeParseWorkflowDocument({
      steps: [
        req("crear"),
        {
          id: "f",
          kind: "fetch",
          dependsOn: ["crear"],
          fetch: { method: "POST", url: "https://hooks.example.com/{{thingId}}", body: '{"a":1}', useSession: false },
        },
      ],
    });
    assert.equal(valido.ok, true);

    assert.equal(safeParseWorkflowDocument({ steps: [{ id: "f", kind: "fetch" }] }).ok, false);
    assert.equal(
      safeParseWorkflowDocument({
        steps: [{ id: "f", kind: "fetch", requestTemplateId: uuid(1), fetch: { method: "GET", url: "/x" } }],
      }).ok,
      false,
    );
    // El bloque fetch solo en un nodo fetch: en una petición significaría dos llamadas a la vez.
    assert.equal(
      safeParseWorkflowDocument({ steps: [{ id: "a", requestTemplateId: uuid(1), fetch: { method: "GET", url: "/x" } }] }).ok,
      false,
    );
    assert.equal(
      safeParseWorkflowDocument({ steps: [{ id: "f", kind: "fetch", fetch: { method: "GET", url: "/x\r\nHost: y" } }] }).ok,
      false,
    );
  });

  test("set asigna variables con nombre válido; script lleva código y solo lee una dependencia", () => {
    const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;
    assert.equal(parse([{ id: "s", kind: "set", set: { assignments: [{ variable: "total", value: "{{a}}-{{$uuid}}" }] } }]), true);
    assert.equal(parse([{ id: "s", kind: "set", set: { assignments: [{ variable: "mal nombre", value: "x" }] } }]), false);
    assert.equal(parse([{ id: "s", kind: "set", set: { assignments: [] } }]), false);
    assert.equal(parse([{ id: "s", kind: "set" }]), false);
    assert.equal(parse([{ id: "a", requestTemplateId: uuid(1), set: { assignments: [{ variable: "x", value: "y" }] } }]), false);

    assert.equal(
      parse([req("crear"), { id: "x", kind: "script", dependsOn: ["crear"], script: { from: "crear", code: "pm.test('a', () => {})" } }]),
      true,
    );
    assert.equal(parse([{ id: "x", kind: "script", script: { code: "pm.variables.set('a', '1')" } }]), true);
    assert.equal(parse([{ id: "x", kind: "script", script: { code: "   " } }]), false);
    assert.equal(parse([req("crear"), { id: "x", kind: "script", script: { from: "crear", code: "1" } }]), false);
    assert.equal(parse([{ id: "x", kind: "script", requestTemplateId: uuid(1), script: { code: "1" } }]), false);
  });

  test("un reintento repite una petición o un fetch del que depende, y necesita una comprobación", () => {
    const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;
    const check = { source: "body", path: "data.state", operator: "equals", value: "done" };
    const poll = (from: string, extra: Record<string, unknown> = {}) => ({
      id: "p",
      kind: "poll",
      dependsOn: [from],
      poll: { from, attempts: 5, delayMs: 1000 },
      checks: [check],
      ...extra,
    });
    assert.equal(parse([req("crear"), poll("crear")]), true);
    assert.equal(parse([{ id: "f", kind: "fetch", fetch: { method: "GET", url: "/jobs/1" } }, poll("f")]), true);
    // Sin comprobación nada dice cuándo parar.
    assert.equal(parse([req("crear"), poll("crear", { checks: undefined })]), false);
    // Lo que repite tiene que ser una dependencia, y una petición o un fetch sin bucle ni login.
    assert.equal(parse([req("crear"), poll("crear", { dependsOn: undefined })]), false);
    assert.equal(parse([{ id: "s", kind: "set", set: { assignments: [{ variable: "a", value: "1" }] } }, poll("s")]), false);
    assert.equal(
      parse([{ ...req("crear"), kind: "login", authorizes: { from: "body", path: "token" } }, poll("crear")]),
      false,
    );
    assert.equal(parse([req("crear"), poll("crear", { poll: { from: "crear", attempts: 21, delayMs: 0 } })]), false);
    assert.equal(parse([req("crear"), { id: "p", kind: "poll", dependsOn: ["crear"], checks: [check] }]), false);
    assert.equal(parse([{ ...req("crear"), poll: { from: "crear", attempts: 1, delayMs: 0 } }]), false);
  });

  test("un nodo reintento vigila un paso que puede fallar y repite desde él o desde uno anterior", () => {
    const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;
    const retry = (from: string, target: string, extra: Record<string, unknown> = {}) => ({
      id: "r",
      kind: "retry",
      dependsOn: [from],
      rerun: { from, target, attempts: 3, delayMs: 0 },
      ...extra,
    });
    const leer = req("leer", { dependsOn: ["crear"] });
    assert.equal(parse([req("crear"), leer, retry("leer", "leer")]), true);
    assert.equal(parse([req("crear"), leer, retry("leer", "crear")]), true);
    // Lo que cuelga del reintento es su salida «si se agota».
    assert.equal(parse([req("crear"), leer, retry("leer", "crear"), req("plan-b", { dependsOn: ["r"] })]), true);
    // Solo desde el paso vigilado o uno anterior: ni un paso suelto ni uno posterior.
    assert.equal(parse([req("crear"), leer, req("suelto"), retry("leer", "suelto")]), false);
    assert.equal(parse([req("crear"), leer, req("tras", { dependsOn: ["leer"] }), retry("leer", "tras")]), false);
    assert.equal(parse([req("crear"), leer, retry("leer", "no-existe")]), false);
    // Su única entrada es el paso vigilado, y ese paso tiene que poder fallar.
    assert.equal(parse([req("crear"), leer, retry("leer", "leer", { dependsOn: ["leer", "crear"] })]), false);
    assert.equal(parse([{ id: "w", kind: "wait", waitMs: 10 }, retry("w", "w")]), false);
    assert.equal(parse([req("crear"), leer, retry("leer", "leer"), { ...retry("leer", "leer"), id: "r2" }]), false);
    assert.equal(parse([req("crear"), leer, { id: "r", kind: "retry", dependsOn: ["leer"] }]), false);
    assert.equal(parse([req("crear"), leer, retry("leer", "leer", { rerun: { from: "leer", target: "leer", attempts: 11, delayMs: 0 } })]), false);
    assert.equal(parse([req("crear", { rerun: { from: "crear", target: "crear", attempts: 1, delayMs: 0 } })]), false);
    // El tramo no pasa por un sondeo, que repite por su cuenta.
    const sondeo = { id: "p", kind: "poll", dependsOn: ["crear"], poll: { from: "crear", attempts: 2, delayMs: 0 }, checks: [check] };
    assert.equal(parse([req("crear"), sondeo, req("leer", { dependsOn: ["p"] }), retry("leer", "crear")]), false);
  });

  test("el tramo de un reintento va desde donde repite hasta el paso vigilado, sin ramas ajenas", () => {
    const steps: WorkflowStep[] = [
      { id: "crear", requestTemplateId: uuid(1) },
      { id: "listar", requestTemplateId: uuid(1), dependsOn: ["crear"] },
      { id: "borrar", requestTemplateId: uuid(1), dependsOn: ["crear"] },
      { id: "leer", requestTemplateId: uuid(1), dependsOn: ["borrar"] },
    ];
    assert.deepEqual(rerunPath(steps, "crear", "leer"), ["crear", "borrar", "leer"]);
    assert.deepEqual(rerunPath(steps, "leer", "leer"), ["leer"]);
    assert.equal(rerunPath(steps, "listar", "leer"), null);
  });

  test("un esquema valida un paso del que depende; el del contrato solo sobre una petición guardada", () => {
    const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;
    const fetchNode = { id: "f", kind: "fetch", fetch: { method: "GET", url: "/x" } };
    const schema = (from: string, block: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
      id: "e",
      kind: "schema",
      dependsOn: [from],
      schema: { from, source: "custom", json: '{"type":"object"}', ...block },
      ...extra,
    });
    assert.equal(parse([req("crear"), schema("crear")]), true);
    assert.equal(parse([req("crear"), schema("crear", { source: "contract", json: undefined, strict: true })]), true);
    assert.equal(parse([fetchNode, schema("f")]), true);
    // Un nombre de propiedad «pattern» vale; la palabra clave no.
    assert.equal(parse([req("crear"), schema("crear", { json: '{"properties":{"pattern":{"type":"string"}}}' })]), true);
    assert.equal(parse([fetchNode, schema("f", { source: "contract" })]), false);
    assert.equal(parse([req("crear"), schema("crear", { json: "{no" })]), false);
    assert.equal(parse([req("crear"), schema("crear", { json: "[1]" })]), false);
    assert.equal(parse([req("crear"), schema("crear", { json: undefined })]), false);
    assert.equal(
      parse([req("crear"), schema("crear", { json: '{"properties":{"a":{"type":"string","pattern":"^(a+)+$"}}}' })]),
      false,
    );
    assert.equal(parse([req("crear"), schema("crear", {}, { dependsOn: undefined })]), false);
    assert.equal(parse([req("crear"), { id: "e", kind: "schema", dependsOn: ["crear"] }]), false);
    assert.equal(parse([req("crear", { schema: { from: "crear", source: "custom", json: "{}" } })]), false);
  });

  test("un bucle recorre lo que cuelga de «cada»; dentro solo se depende de lo que ya terminó", () => {
    const parse = (steps: unknown[]) => safeParseWorkflowDocument({ steps }).ok;
    const loop = { id: "b", kind: "loop", dependsOn: ["listar"], loop: { from: "listar", path: "data", as: "item" } };
    const inside = req("leer", { dependsOn: ["b"], inLoop: "b" });
    const downstream = req("anota", { dependsOn: ["leer"] });
    const after = req("fin", { dependsOn: ["b"] });
    const steps = [req("listar"), loop, inside, downstream, after];
    // Lo que cuelga de un nodo del cuerpo también es cuerpo; «fin» depende del bucle y queda fuera.
    assert.deepEqual(loopBody(steps as WorkflowStep[], "b"), ["leer", "anota"]);
    assert.equal(parse(steps), true);
    // Un antecesor del bucle ya terminó; un paso que corre a su lado todavía no.
    assert.equal(parse([req("listar"), loop, req("leer", { dependsOn: ["b", "listar"], inLoop: "b" })]), true);
    assert.equal(
      parse([req("listar"), loop, req("otro", { dependsOn: ["listar"] }), req("leer", { dependsOn: ["b", "otro"], inLoop: "b" })]),
      false,
    );
    // Sin anidar, sin forEach propio, y `inLoop` solo hacia un bucle del que depende.
    assert.equal(
      parse([req("listar"), loop, { id: "b2", kind: "loop", dependsOn: ["b"], inLoop: "b", loop: { from: "b", path: "x", as: "y" } }]),
      false,
    );
    assert.equal(parse([req("listar"), loop, req("leer", { dependsOn: ["b"], inLoop: "b", forEach: { from: "b", path: "x", as: "z" } })]), false);
    assert.equal(parse([req("listar"), loop, req("leer", { inLoop: "b" })]), false);
    assert.equal(parse([req("listar"), req("leer", { dependsOn: ["listar"], inLoop: "listar" })]), false);
    assert.equal(parse([req("listar"), { id: "b", kind: "loop", dependsOn: ["listar"] }]), false);
    assert.equal(parse([req("listar"), { ...loop, loop: { from: "listar", path: "data", as: "item", max: 201 } }]), false);
  });

  test("dos set que pueden correr a la vez no escriben la misma variable", () => {
    const doc = safeParseWorkflowDocument({
      steps: [
        req("crear"),
        { id: "a", kind: "set", dependsOn: ["crear"], set: { assignments: [{ variable: "total", value: "1" }] } },
        { id: "b", kind: "set", dependsOn: ["crear"], set: { assignments: [{ variable: "total", value: "2" }] } },
      ],
    });
    assert.equal(doc.ok, false);
    if (!doc.ok) assert.ok(doc.issues.some((i) => i.detail.includes("total")));
  });
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
