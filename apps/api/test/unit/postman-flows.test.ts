/**
 * Una colección de Postman, leída como flujos de este proyecto.
 *
 * Dos mitades, y la segunda es la delicada. La primera es el reparto: una carpeta de primer nivel
 * es un flujo, el orden de la carpeta son las aristas, y una petición que el contrato no declara
 * entra como nodo «fetch» en vez de inventarse una operación.
 *
 * La segunda es el traductor de scripts, y toda su gracia está en **cuándo se rinde**. Esto no es
 * un intérprete de JavaScript: si un `pm.test` afirma algo que no se sabe leer, traducir el resto y
 * callar lo que falta dejaría un flujo verde sobre una respuesta que nadie comprobó. Así que o se
 * entiende el script entero —y entonces salen comprobaciones que se leen y se editan en el
 * inspector— o se guarda tal cual y lo ejecuta el sandbox. No hay traducción a medias, y eso es lo
 * que la mayoría de estas pruebas fija.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readPostmanCollection, type PostmanItem } from "@/modules/workflows/domain/import-requests";
import { translatePostmanScript } from "@/modules/workflows/domain/postman-scripts";
import { definitionFrom, fetchCallFrom, flowsOf, readItemScripts } from "@/modules/workflows/domain/postman-flows";

const item = (overrides: Partial<PostmanItem> = {}): PostmanItem => ({
  trail: [],
  name: "Crear pedido",
  label: "Crear pedido",
  request: {
    name: "Crear pedido",
    method: "POST",
    url: "{{base}}/pedidos",
    headers: {},
    examples: [],
    body: { type: "none" },
    auth: { type: "inherit", params: {} },
  },
  prerequest: "",
  test: "",
  ...overrides,
});

const collection = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    info: { name: "Tienda", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: items,
    ...extra,
  });

const request = (name: string, method: string, url: string, events?: unknown[]) => ({
  name,
  request: { method, url, header: [] },
  ...(events ? { event: events } : {}),
});

const testEvent = (lines: string[]) => [{ listen: "test", script: { exec: lines } }];

describe("leer la colección entera", () => {
  test("los scripts de cada petición vienen con ella", () => {
    const read = readPostmanCollection(
      collection([request("Alta", "POST", "{{base}}/pedidos", testEvent(["pm.response.to.have.status(201);"]))]),
    );
    assert.equal(read?.items[0].test, "pm.response.to.have.status(201);");
    assert.equal(read?.name, "Tienda");
  });

  test("un evento apagado en Postman no se lee", () => {
    const read = readPostmanCollection(
      collection([
        {
          name: "Alta",
          request: { method: "GET", url: "/x" },
          event: [{ listen: "test", disabled: true, script: { exec: ["x"] } }],
        },
      ]),
    );
    assert.equal(read?.items[0].test, "");
  });

  test("un `script.src` no se sigue: sería esta importación pidiendo una URL ajena", () => {
    const read = readPostmanCollection(
      collection([
        {
          name: "Alta",
          request: { method: "GET", url: "/x" },
          event: [{ listen: "test", script: { src: "https://ajeno/x.js" } }],
        },
      ]),
    );
    assert.equal(read?.items[0].test, "");
  });

  test("lo que no es JSON no es una colección", () => {
    assert.equal(readPostmanCollection("no soy json"), null);
  });
});

describe("una carpeta de primer nivel es un flujo", () => {
  test("las carpetas se separan y lo que está en la raíz se llama como la colección", () => {
    const read = readPostmanCollection(
      collection([
        request("Ping", "GET", "/ping"),
        { name: "Pedidos", item: [request("Alta", "POST", "/pedidos"), request("Leer", "GET", "/pedidos/1")] },
      ]),
    )!;
    const flows = flowsOf(read);
    assert.deepEqual(
      flows.map((flow) => [flow.name, flow.items.length]),
      [
        ["Tienda", 1],
        ["Pedidos", 2],
      ],
    );
  });

  test("una carpeta dentro de otra sigue siendo el flujo de la de fuera", () => {
    const read = readPostmanCollection(
      collection([{ name: "Pedidos", item: [{ name: "Alta", item: [request("Crear", "POST", "/pedidos")] }] }]),
    )!;
    const flows = flowsOf(read);
    assert.equal(flows.length, 1);
    assert.equal(flows[0].name, "Pedidos");
    // El nombre completo se conserva para que dos «Crear» de dos carpetas se distingan.
    assert.equal(flows[0].items[0].label, "Pedidos / Alta / Crear");
  });
});

describe("un test de Postman, leído como comprobaciones", () => {
  test("el estado que afirma el test es lo que el nodo espera, y no además una comprobación", () => {
    const read = readItemScripts(
      item({ test: 'pm.test("Se creó", function () { pm.response.to.have.status(201); });' }),
    );
    assert.equal(read.expectedStatus, 201);
    // Sacado de las comprobaciones a propósito: el estado ya *es* la aserción principal de un caso,
    // y dejarlo en los dos sitios nombraría la misma afirmación dos veces.
    assert.deepEqual(read.checks, []);
    assert.equal(read.test, "");
    assert.equal(read.reason, null);
  });

  test("el nombre del pm.test es la etiqueta que sale en el informe", () => {
    const translated = translatePostmanScript(
      'pm.test("Trae el total", function () { const jsonData = pm.response.json(); pm.expect(jsonData.total).to.eql(42); });',
    );
    assert.equal(translated.untranslatable, null);
    assert.deepEqual(translated.checks, [
      { label: "Trae el total", source: "body", path: "total", operator: "equals", value: 42 },
    ]);
  });

  test("los índices y los corchetes son el mismo camino que los puntos", () => {
    const translated = translatePostmanScript(
      'const body = pm.response.json();\npm.expect(body.data[0]["id"]).to.exist;',
    );
    assert.deepEqual(translated.checks, [{ source: "body", path: "data.0.id", operator: "exists" }]);
  });

  test("el tiempo de respuesta, la cabecera y la lista tienen cada uno su operador", () => {
    const translated = translatePostmanScript(
      [
        "pm.expect(pm.response.responseTime).to.be.below(300);",
        'pm.response.to.have.header("X-Request-Id");',
        "const j = pm.response.json();",
        "pm.expect(j.items).to.be.an('array');",
        "pm.expect(j.items).to.have.lengthOf(3);",
      ].join("\n"),
    );
    assert.equal(translated.untranslatable, null);
    assert.deepEqual(translated.checks, [
      { source: "durationMs", operator: "less_than", value: 300 },
      { source: "header", path: "X-Request-Id", operator: "exists" },
      { source: "body", path: "items", operator: "is_array" },
      { source: "body", path: "items", operator: "has_length", value: 3 },
    ]);
  });

  test("un `not` invierte el operador, y cuando no hay inverso el script se guarda entero", () => {
    const negated = translatePostmanScript('const j = pm.response.json();\npm.expect(j.nombre).to.not.eql("");');
    assert.deepEqual(negated.checks, [{ source: "body", path: "nombre", operator: "not_equals", value: "" }]);
    // `to.be.empty` sin negar no tiene operador aquí, y adivinarlo al revés es justo el error que
    // esto se niega a cometer.
    const guessed = translatePostmanScript("const j = pm.response.json();\npm.expect(j.items).to.be.empty;");
    assert.notEqual(guessed.untranslatable, null);
  });

  test("`pm.environment.set` es una captura, con su camino", () => {
    const translated = translatePostmanScript(
      'const jsonData = pm.response.json();\npm.environment.set("pedidoId", jsonData.id);',
    );
    assert.equal(translated.untranslatable, null);
    assert.deepEqual(translated.captures, [{ variable: "pedidoId", from: "body", path: "id" }]);
  });

  test("guardar el cuerpo entero no es una captura: una variable es texto que va a una URL", () => {
    const translated = translatePostmanScript(
      'const jsonData = pm.response.json();\npm.collectionVariables.set("todo", jsonData);',
    );
    assert.notEqual(translated.untranslatable, null);
  });

  test("una cabecera también se puede capturar", () => {
    const translated = translatePostmanScript('pm.globals.set("trace", pm.response.headers.get("X-Trace"));');
    assert.deepEqual(translated.captures, [{ variable: "trace", from: "header", path: "X-Trace" }]);
  });

  test("un `//` dentro de una cadena no es un comentario", () => {
    const translated = translatePostmanScript(
      'const j = pm.response.json();\npm.expect(j.url).to.eql("https://api.ejemplo.com/x");',
    );
    assert.deepEqual(translated.checks, [
      { source: "body", path: "url", operator: "equals", value: "https://api.ejemplo.com/x" },
    ]);
  });

  test("un `console.log` no afirma nada y se deja caer", () => {
    const translated = translatePostmanScript(
      'pm.test("Vale", function () { console.log("hola"); pm.response.to.have.status(200); });',
    );
    assert.equal(translated.untranslatable, null);
    assert.equal(translated.checks.length, 1);
  });

  test("un pm.test que no afirma nada reconocible no se traduce: borraría su única afirmación", () => {
    const translated = translatePostmanScript('pm.test("Raro", function () { console.log("solo esto"); });');
    assert.notEqual(translated.untranslatable, null);
  });

  // Lo que sigue salió de pasar una colección generada de verdad —53 peticiones— por el lector: no
  // son casos inventados, son las formas que de hecho aparecen y que antes se perdían enteras.

  test("un nombre atado a una parte del cuerpo lleva su camino, no la raíz", () => {
    // `const data = pm.response.json().data` es al menos tan común como atar la raíz, y leerlo como
    // «el cuerpo entero» dejaría todas las comprobaciones de después un nivel desplazadas.
    const translated = translatePostmanScript(
      'const data = pm.response.json().data;\npm.expect(data.name_sap).to.eql("ARROZ");',
    );
    assert.deepEqual(translated.checks, [
      { source: "body", path: "data.name_sap", operator: "equals", value: "ARROZ" },
    ]);
  });

  test("y un nombre atado a otro nombre encadena el camino", () => {
    const translated = translatePostmanScript(
      'const data = pm.response.json().data;\nconst attributes = data.attributes_akn;\npm.expect(attributes.origen).to.eql("Tolima");',
    );
    assert.deepEqual(translated.checks, [
      { source: "body", path: "data.attributes_akn.origen", operator: "equals", value: "Tolima" },
    ]);
  });

  test("una lista o un objeto literal son un valor como cualquier otro", () => {
    const translated = translatePostmanScript(
      'pm.test("vacía", function () { pm.expect(pm.response.json().data).to.eql([]); });',
    );
    assert.equal(translated.untranslatable, null);
    assert.deepEqual(translated.checks, [
      { label: "vacía", source: "body", path: "data", operator: "equals", value: [] },
    ]);
  });

  test("pero un valor calculado no lo es, y el script se guarda entero", () => {
    // `[Number(pm.collectionVariables.get("x"))]` no es un literal: se resuelve al ejecutar, y una
    // comprobación no puede afirmarlo. El sandbox sí, así que ahí va.
    const translated = translatePostmanScript(
      'pm.expect(pm.response.json().data).to.eql([Number(pm.collectionVariables.get("chk_product_a"))]);',
    );
    assert.notEqual(translated.untranslatable, null);
  });

  test("un bucle o un `if` mandan el script entero al nodo script", () => {
    const read = readItemScripts(
      item({ test: "const j = pm.response.json();\nfor (const x of j.items) { pm.expect(x.id).to.exist; }" }),
    );
    assert.notEqual(read.reason, null);
    assert.match(read.test, /for \(const x of j.items\)/);
    assert.deepEqual(read.checks, []);
  });
});

describe("el grafo que sale de una carpeta", () => {
  const draft = (label: string, extra: Partial<Parameters<typeof definitionFrom>[0][number]> = {}) => ({
    label,
    source: { kind: "request" as const, requestTemplateId: "11111111-1111-4111-8111-111111111111" },
    checks: [],
    captures: [],
    prerequest: "",
    test: "",
    ...extra,
  });

  test("cada nodo depende del anterior: la carpeta se recorría en orden", () => {
    const definition = definitionFrom([draft("Alta"), draft("Leer")]);
    assert.deepEqual(
      definition.steps.map((step) => [step.id, step.dependsOn]),
      [
        ["alta", undefined],
        ["leer", ["alta"]],
      ],
    );
  });

  test("el id del nodo sale del nombre, porque el id es lo que el informe llama al paso", () => {
    const definition = definitionFrom([draft("Crear pedido ñ"), draft("Crear pedido ñ")]);
    assert.deepEqual(
      definition.steps.map((step) => step.id),
      ["crear-pedido-n", "crear-pedido-n-2"],
    );
  });

  test("el prerequest va antes y el test después, y el test lee la respuesta del nodo", () => {
    const definition = definitionFrom([
      draft("Alta", { prerequest: 'pm.environment.set("x", "1");', test: "if (true) {}" }),
    ]);
    assert.deepEqual(
      definition.steps.map((step) => [step.id, step.kind ?? "request", step.dependsOn]),
      [
        ["alta-antes", "script", undefined],
        ["alta", "request", ["alta-antes"]],
        ["alta-test", "script", ["alta"]],
      ],
    );
    assert.equal(definition.steps[2].script?.from, "alta");
  });

  test("un nodo fetch lleva su llamada escrita y ninguna petición guardada", () => {
    const call = fetchCallFrom(item({ request: { ...item().request, headers: { "X-Tenant": "acme" } } }), 201);
    assert.notEqual(typeof call, "string");
    if (typeof call === "string") return;
    const definition = definitionFrom([draft("Alta", { source: { kind: "fetch", fetch: call.fetch } })]);
    assert.equal(definition.steps[0].kind, "fetch");
    assert.equal(definition.steps[0].requestTemplateId, undefined);
    assert.deepEqual(definition.steps[0].fetch, {
      method: "POST",
      url: "{{base}}/pedidos",
      headers: { "X-Tenant": "acme" },
      expectedStatus: 201,
    });
  });
});

describe("la llamada que se escribe en un nodo fetch", () => {
  const withHeaders = (headers: Record<string, string>) =>
    fetchCallFrom(item({ request: { ...item().request, headers } }), null);

  test("`Bearer {{token}}` se queda: dice dónde está el secreto, no es uno", () => {
    const call = withHeaders({ Authorization: "Bearer {{token}}" });
    assert.notEqual(typeof call, "string");
    if (typeof call === "string") return;
    assert.deepEqual(call.fetch.headers, { Authorization: "Bearer {{token}}" });
    assert.equal(call.fetch.useSession, undefined);
  });

  test("una credencial escrita a mano se quita y el nodo presenta la sesión de la corrida", () => {
    const call = withHeaders({ Authorization: "Bearer eyJhbGciOi.secreto" });
    assert.notEqual(typeof call, "string");
    if (typeof call === "string") return;
    assert.equal(call.droppedCredential, true);
    assert.deepEqual(call.fetch.headers, undefined);
    assert.equal(call.fetch.useSession, true);
  });

  test("las cabeceras del transporte no describen la petición y se caen", () => {
    const call = withHeaders({ Host: "api.ejemplo.com", "Postman-Token": "abc", "X-Tenant": "acme" });
    assert.notEqual(typeof call, "string");
    if (typeof call === "string") return;
    assert.deepEqual(call.fetch.headers, { "X-Tenant": "acme" });
  });

  test("un cuerpo JSON viaja como texto con su tipo de contenido", () => {
    const call = fetchCallFrom(item({ request: { ...item().request, body: { type: "json", json: { a: 1 } } } }), null);
    assert.notEqual(typeof call, "string");
    if (typeof call === "string") return;
    assert.equal(call.fetch.headers?.["Content-Type"], "application/json");
    assert.equal(call.fetch.body, '{\n  "a": 1\n}');
  });

  test("un multipart no cabe en un nodo fetch y se dice por qué", () => {
    const call = fetchCallFrom(
      item({ request: { ...item().request, body: { type: "form-data", fields: { f: "1" }, disabledFields: {} } } }),
      null,
    );
    assert.equal(typeof call, "string");
  });
});

describe("la autenticación de la llamada escrita a mano", () => {
  test("el bloque `auth` de la petición viaja al nodo fetch", () => {
    const call = fetchCallFrom(
      item({
        request: {
          name: "x",
          method: "GET",
          url: "https://hooks.ejemplo.com/aviso",
          headers: {},
          examples: [],
          body: { type: "none" },
          auth: { type: "bearer", params: { token: "{{hookToken}}" } },
        },
      }),
      null,
    );
    assert.ok(typeof call !== "string");
    assert.deepEqual(call.fetch.auth, { type: "bearer", params: { token: "{{hookToken}}" } });
  });

  test("`inherit` no se guarda: es lo que hace una llamada sin bloque", () => {
    const call = fetchCallFrom(item(), null);
    assert.ok(typeof call !== "string");
    assert.equal(call.fetch.auth, undefined);
  });
});
