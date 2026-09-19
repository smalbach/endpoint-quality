/**
 * Los rincones del exportador a Postman que las pruebas de estilo no pisan: los valores por
 * defecto, los nodos incompletos, los entornos, los ejemplos guardados y cada rama del traductor
 * de comprobaciones. Cada caso mira lo que queda escrito en el fichero, no que la función corra.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { captureLines, checkLines, toPostmanExport } from "@/modules/projects/domain/postman-export";
import type { ProjectBundle } from "@/modules/projects/domain/project-bundle";

const IDS = { collectionId: "col-1", environmentIds: [] as string[] };

type Item = {
  name: string;
  item?: Item[];
  event?: { listen: string; script: { exec: string[] } }[];
  request?: Record<string, unknown> & {
    method?: string;
    url?: { raw: string; query?: unknown };
    header?: unknown;
    body?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    description?: string;
  };
  response?: Record<string, unknown>[];
};

const bundle = (patch: Record<string, unknown> = {}): ProjectBundle =>
  ({
    format: "endpoint-quality/project",
    version: 1,
    project: { name: "Tienda" },
    settings: { baseUrl: "https://api.tienda.test" },
    ...patch,
  }) as unknown as ProjectBundle;

const template = (patch: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Crear pedido",
  operationId: "createOrder",
  method: "post",
  path: "/pedidos/{id}",
  description: null,
  expectedStatus: 201,
  parameters: { id: "7" },
  disabledParameters: {},
  headers: {},
  disabledHeaders: {},
  body: { type: "none" },
  ...patch,
});

const flows = (workflows: unknown[], templates: unknown[] = [template()]) => ({
  flows: { requestTemplates: templates, workflows, datasets: [], suites: [] },
});
const workflow = (steps: unknown, patch: Record<string, unknown> = {}) => ({
  id: "w1",
  name: "Pedidos",
  status: "ready",
  definition: { steps },
  ...patch,
});
const folders = (exported: ReturnType<typeof toPostmanExport>) => exported.collection.item as unknown as Item[];
const requests = (exported: ReturnType<typeof toPostmanExport>) => folders(exported)[0]!.item!;

const endpoint = (patch: Record<string, unknown> = {}) => ({
  method: "GET",
  path: "/pedidos/{id}",
  description: "",
  pathParameters: [{ name: "id", type: "string", description: "", value: "" }],
  query: [],
  headers: [],
  body: { mode: "none", text: "", contentType: "text/plain", fields: [] },
  requiresAuth: false,
  tags: [],
  status: "active",
  operationId: null,
  preRequestScript: "",
  postResponseScript: "",
  ...patch,
});
const exportEndpoints = (endpoints: unknown[], settings: Record<string, unknown> = { baseUrl: "https://x.test" }) =>
  toPostmanExport(bundle({ endpoints, settings }), IDS, { contents: "endpoints" });

describe("la colección con lo mínimo", () => {
  test("sin nombre de proyecto ni baseUrl: nombre por defecto y ninguna variable", () => {
    const exported = toPostmanExport(
      { format: "endpoint-quality/project", version: 1 } as unknown as ProjectBundle,
      IDS,
    );
    assert.equal(exported.collection.info.name, "Proyecto");
    assert.deepEqual(exported.collection.variable, []);
    assert.deepEqual(exported.collection.item, []);
    assert.equal("description" in exported.collection.info, false);
    assert.deepEqual(exported.environments, []);
  });

  test("la descripción del proyecto va en `info`", () => {
    const exported = toPostmanExport(bundle({ settings: { description: "Una tienda" } }), IDS);
    assert.equal(exported.collection.info.description, "Una tienda");
  });

  test("un flujo sin nodos que Postman pueda mandar no sale como carpeta vacía: se dice", () => {
    const exported = toPostmanExport(
      bundle(flows([workflow([{ id: "w", kind: "delay", delay: { ms: 5 } }])])),
      IDS,
    );
    assert.deepEqual(exported.collection.item, []);
    assert.ok(
      exported.skipped.some((entry) => entry.what === "flujo «Pedidos»" && /ningún nodo/.test(entry.detail)),
    );
    assert.ok(exported.skipped.some((entry) => /nodo «delay»/.test(entry.detail)));
  });

  test("un grafo con dependencias rotas se exporta en el orden del documento", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            { id: "b", requestTemplateId: "t1", dependsOn: ["no-existe"] },
            { id: "a", requestTemplateId: "t1" },
          ]),
        ]),
      ),
      IDS,
    );
    assert.equal(requests(exported).length, 2);
  });

  test("un flujo sin `steps` no rompe la exportación", () => {
    const exported = toPostmanExport(
      bundle(flows([{ id: "w1", name: "Vacío", status: "ready", definition: {} }])),
      IDS,
    );
    assert.deepEqual(exported.collection.item, []);
    assert.equal(exported.skipped[0]!.what, "flujo «Vacío»");
  });
});

describe("nodos de petición guardada", () => {
  test("un nodo sin petición o con una que no existe sale en `skipped`", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            { id: "s1" },
            { id: "s2", requestTemplateId: "otro" },
          ]),
        ]),
      ),
      IDS,
    );
    assert.deepEqual(
      exported.skipped.filter((entry) => /no está en el proyecto/.test(entry.detail)).map((entry) => entry.what),
      ["flujo «Pedidos», nodo s1", "flujo «Pedidos», nodo s2"],
    );
  });

  test("parámetros apagados salen como `query` desactivada, salvo los de la ruta", () => {
    const exported = toPostmanExport(
      bundle(
        flows(
          [workflow([{ id: "s1", requestTemplateId: "t1" }])],
          [
            template({
              description: "Alta de pedido",
              disabledParameters: { id: "9", viejo: "1" },
              body: { type: "raw", text: "<p/>", contentType: "text/html" },
            }),
          ],
        ),
      ),
      IDS,
    );
    const request = requests(exported)[0]!.request!;
    assert.deepEqual(request.url, {
      raw: "{{baseUrl}}/pedidos/7",
      query: [{ key: "viejo", value: "1", disabled: true }],
    });
    assert.equal(request.description, "Alta de pedido");
    assert.deepEqual(request.body, { mode: "raw", raw: "<p/>", options: { raw: { language: "html" } } });
  });

  test("un cuerpo raw XML y uno de texto dicen su lenguaje", () => {
    const withBody = (body: unknown) =>
      requests(
        toPostmanExport(
          bundle(flows([workflow([{ id: "s1", requestTemplateId: "t1" }])], [template({ body })])),
          IDS,
        ),
      )[0]!.request!.body;
    assert.deepEqual((withBody({ type: "raw", text: "<a/>", contentType: "application/xml" }) as never)["options"], {
      raw: { language: "xml" },
    });
    assert.deepEqual((withBody({ type: "raw", text: "hola", contentType: "text/plain" }) as never)["options"], {
      raw: { language: "text" },
    });
    assert.equal(withBody(undefined), undefined);
  });

  test("un formulario urlencoded con filas apagadas las marca `disabled`", () => {
    const exported = toPostmanExport(
      bundle(
        flows(
          [workflow([{ id: "s1", requestTemplateId: "t1" }])],
          [
            template({
              body: { type: "x-www-form-urlencoded", fields: { a: "1" }, disabledFields: { b: "2" } },
            }),
          ],
        ),
      ),
      IDS,
    );
    assert.deepEqual(requests(exported)[0]!.request!.body, {
      mode: "urlencoded",
      urlencoded: [
        { key: "a", value: "1" },
        { key: "b", value: "2", disabled: true },
      ],
    });
  });
});

describe("nodos fetch y graphql", () => {
  test("un nodo fetch o graphql sin su llamada no escribe nada", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            { id: "f", kind: "fetch" },
            { id: "g", kind: "graphql" },
          ]),
        ]),
      ),
      IDS,
    );
    assert.deepEqual(exported.collection.item, []);
  });

  test("fetch: consulta sin `=`, cabeceras apagadas, lenguaje del cuerpo por su Content-Type y auth sin secreto", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            {
              id: "f",
              kind: "fetch",
              fetch: {
                method: "put",
                url: "https://h.test/x?flag&a=1",
                headers: { "Content-Type": "application/xml" },
                disabledHeaders: { "X-Old": "1" },
                body: "<a/>",
                auth: { type: "basic", params: { username: "ana", password: "secreto" } },
              },
            },
          ]),
        ]),
      ),
      IDS,
    );
    const item = requests(exported)[0]!;
    assert.equal(item.name, "put https://h.test/x");
    assert.equal(item.request!.method, "PUT");
    assert.deepEqual(item.request!.url!.query, [
      { key: "flag", value: "" },
      { key: "a", value: "1" },
    ]);
    assert.deepEqual(item.request!.header, [
      { key: "Content-Type", value: "application/xml" },
      { key: "X-Old", value: "1", disabled: true },
    ]);
    assert.deepEqual((item.request!.body as { options: unknown }).options, { raw: { language: "xml" } });
    const auth = item.request!.auth as { type: string; basic: { key: string; value: string }[] };
    assert.equal(auth.type, "basic");
    assert.deepEqual(
      auth.basic.find((entry) => entry.key === "password"),
      { key: "password", value: "", type: "string" },
    );
    assert.ok(exported.skipped.some((entry) => /«password»/.test(entry.detail)));
  });

  test("fetch sin cabeceras, sin cuerpo y con auth heredada: nada de eso se escribe", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            { id: "f", kind: "fetch", fetch: { method: "GET", url: "https://h.test/x", auth: { type: "inherit", params: {} } } },
          ]),
        ]),
      ),
      IDS,
    );
    const request = requests(exported)[0]!.request!;
    assert.deepEqual(request.header, []);
    assert.equal(request.body, undefined);
    assert.equal(request.auth, undefined);
    assert.deepEqual(request.url, { raw: "https://h.test/x" });
  });

  test("graphql con operationName y allowErrors: sale la petición y se avisa de lo que no cabe", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            {
              id: "pais",
              kind: "graphql",
              graphql: {
                url: "https://g.test/graphql",
                query: "query Pais { pais { id } }",
                operationName: "Pais",
                allowErrors: true,
              },
            },
          ]),
        ]),
      ),
      IDS,
    );
    const item = requests(exported)[0]!;
    assert.equal(item.name, "Pais");
    assert.deepEqual(item.request!.body, {
      mode: "graphql",
      graphql: { query: "query Pais { pais { id } }", variables: "" },
    });
    assert.deepEqual(
      exported.skipped.map((entry) => entry.detail).filter((detail) => /operationName|errors/.test(detail)).length,
      2,
    );
  });

  test("graphql sin operationName se llama como su nodo y lleva sus variables", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            {
              id: "pais",
              kind: "graphql",
              graphql: {
                url: "https://g.test/graphql",
                query: "{ a }",
                variables: '{"x":1}',
                headers: { "X-A": "1" },
                disabledHeaders: { "X-B": "2" },
              },
            },
          ]),
        ]),
      ),
      IDS,
    );
    const item = requests(exported)[0]!;
    assert.equal(item.name, "pais");
    assert.equal((item.request!.body as { graphql: { variables: string } }).graphql.variables, '{"x":1}');
    assert.deepEqual(exported.skipped, []);
  });
});

describe("scripts y validaciones", () => {
  test("un script con `from` a una petición que ya tiene `test` se añade al mismo evento", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            {
              id: "s1",
              requestTemplateId: "t1",
              checks: [{ source: "status", operator: "equals", value: 201 }],
            },
            { id: "v", kind: "validate", dependsOn: ["s1"], validate: { script: "console.log(1)", from: "s1" } },
          ]),
        ]),
      ),
      IDS,
    );
    const events = requests(exported)[0]!.event!;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.listen, "test");
    assert.equal(events[0]!.script.exec.at(-1), "console.log(1)");
    assert.equal(events[0]!.script.exec[1], "  pm.response.to.have.status(201);");
  });

  test("un script vacío se ignora; uno sin `from` con capturas es el prerequest del siguiente", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            { id: "vacio", kind: "script", script: {} },
            { id: "sin", kind: "validate", validate: {} },
            {
              id: "pre",
              kind: "script",
              script: { code: "" },
              captures: [{ variable: "x", from: "header", path: "X-Id" }],
            },
            { id: "s1", requestTemplateId: "t1", dependsOn: ["pre", "vacio", "sin"] },
          ]),
        ]),
      ),
      IDS,
    );
    const events = requests(exported)[0]!.event!;
    assert.deepEqual(
      events.map((entry) => entry.listen),
      ["prerequest"],
    );
    assert.deepEqual(events[0]!.script.exec, ['pm.collectionVariables.set("x", pm.response.headers.get("X-Id"));']);
    assert.deepEqual(exported.skipped, []);
  });

  test("un script con `from` a un nodo que no se exportó se trata como prerequest del siguiente", () => {
    const exported = toPostmanExport(
      bundle(
        flows([
          workflow([
            { id: "x", kind: "delay", delay: { ms: 1 } },
            { id: "sc", kind: "script", script: { code: "a()\nb()", from: "x" }, dependsOn: ["x"] },
            { id: "s1", requestTemplateId: "t1", dependsOn: ["sc"] },
          ]),
        ]),
      ),
      IDS,
    );
    const item = requests(exported)[0]!;
    assert.deepEqual(item.event, [
      { listen: "prerequest", script: { type: "text/javascript", exec: ["a()", "b()"] } },
    ]);
  });
});

describe("endpoints", () => {
  test("sin endpoints activos se dice; los archivados no salen", () => {
    const exported = exportEndpoints([endpoint({ status: "archived" })]);
    assert.deepEqual(exported.collection.item, []);
    assert.deepEqual(exported.skipped, [{ what: "endpoints", detail: "el proyecto no tiene ninguno activo" }]);
    const none = toPostmanExport(bundle(), IDS, { contents: "endpoints" });
    assert.equal(none.skipped[0]!.what, "endpoints");
  });

  test("sin baseUrl la URL es la ruta; un parámetro sin valor se queda como plantilla", () => {
    const [item] = exportEndpoints([endpoint({ description: "Uno" })], {}).collection.item as unknown as Item[];
    assert.equal(item!.request!.url!.raw, "/pedidos/{id}");
    assert.equal(item!.request!.description, "Uno");
    assert.equal("response" in item!, false);
  });

  test("cabeceras encendidas y apagadas, y una credencial escrita a mano sale vacía", () => {
    const exported = exportEndpoints([
      endpoint({
        headers: [
          { name: "X-A", value: "1", enabled: true },
          { name: "X-B", value: "2", enabled: false },
          { name: "Authorization", value: "Bearer abc", enabled: true },
          { name: "Cookie", value: "{{cookie}}", enabled: false },
        ],
      }),
    ]);
    const [item] = exported.collection.item as unknown as Item[];
    assert.deepEqual(item!.request!.header, [
      { key: "X-A", value: "1" },
      { key: "Authorization", value: "", disabled: true },
      { key: "X-B", value: "2", disabled: true },
      { key: "Cookie", value: "{{cookie}}", disabled: true },
    ]);
    assert.equal(exported.skipped.length, 1);
    assert.match(exported.skipped[0]!.detail, /«Authorization»/);
  });

  test("cuerpo graphql, cuerpo raw, y un graphql en blanco no escribe cuerpo", () => {
    const [gql, xml, blank, noVars] = exportEndpoints([
      endpoint({ body: { mode: "graphql", text: "{ a }", variables: '{"v":1}', contentType: "", fields: [] } }),
      endpoint({ body: { mode: "raw", text: "<a/>", contentType: "text/xml", fields: [] } }),
      endpoint({ body: { mode: "graphql", text: "   ", contentType: "", fields: [] } }),
      endpoint({ body: { mode: "graphql", text: "{ b }", contentType: "", fields: [] } }),
    ]).collection.item as unknown as Item[];
    assert.deepEqual(gql!.request!.body, { mode: "graphql", graphql: { query: "{ a }", variables: '{"v":1}' } });
    assert.deepEqual(xml!.request!.body, { mode: "raw", raw: "<a/>", options: { raw: { language: "xml" } } });
    assert.equal(blank!.request!.body, undefined);
    assert.deepEqual(noVars!.request!.body, { mode: "graphql", graphql: { query: "{ b }", variables: "" } });
  });

  test("un endpoint sin cuerpo tampoco escribe uno", () => {
    const [item] = exportEndpoints([endpoint({ body: undefined })]).collection.item as unknown as Item[];
    assert.equal(item!.request!.body, undefined);
  });

  test("un urlencoded con solo ficheros no escribe cuerpo; un form-data con fichero lo avisa", () => {
    const [onlyFiles, withFile] = exportEndpoints([
      endpoint({
        body: {
          mode: "x-www-form-urlencoded",
          text: "",
          contentType: "",
          fields: [{ name: "doc", value: "", kind: "file", enabled: true }],
        },
      }),
      endpoint({
        body: {
          mode: "form-data",
          text: "",
          contentType: "",
          fields: [{ name: "doc", value: "", kind: "file", enabled: false }],
        },
      }),
    ]).collection.item as unknown as Item[];
    assert.equal(onlyFiles!.request!.body, undefined);
    assert.deepEqual(withFile!.request!.body, {
      mode: "formdata",
      formdata: [{ key: "doc", type: "file", disabled: true }],
    });
  });

  test("la auth del endpoint sale sin sus secretos; `none` sale como tipo `noauth`", () => {
    const [bearer, none] = exportEndpoints([
      endpoint({ auth: { type: "bearer", params: { token: "{{tk}}" } } }),
      endpoint({ auth: { type: "none", params: {} } }),
    ]).collection.item as unknown as Item[];
    assert.deepEqual(bearer!.request!.auth, { type: "bearer", bearer: [{ key: "token", value: "{{tk}}", type: "string" }] });
    assert.equal((none!.request!.auth as { type: string }).type, "noauth");
  });

  test("los ejemplos guardados salen como `response`, con su petición original y su lenguaje", () => {
    const example = (status: number, contentType: string, requestBody = "") => ({
      name: `ej ${status}`,
      request: {
        method: "POST",
        url: "https://x.test/pedidos",
        headers: [
          { name: "X-On", value: "1", enabled: true },
          { name: "X-Off", value: "0", enabled: false },
        ],
        body: { text: requestBody, contentType: "application/xml" },
      },
      response: {
        status,
        contentType,
        headers: [
          { name: "Content-Type", value: contentType, enabled: true },
          { name: "X-Off", value: "0", enabled: false },
        ],
        body: "cuerpo",
      },
    });
    const [item] = exportEndpoints([
      endpoint({
        examples: [
          example(200, "application/json", "<a/>"),
          example(422, "text/xml"),
          example(404, "text/html"),
          example(500, "application/javascript"),
          example(299, "text/plain"),
        ],
      }),
    ]).collection.item as unknown as Item[];
    const responses = item!.response! as {
      status: string;
      code: number;
      _postman_previewlanguage: string;
      header: unknown[];
      originalRequest: { header: unknown[]; body?: { options: unknown } };
    }[];
    assert.deepEqual(
      responses.map((response) => [response.code, response.status, response._postman_previewlanguage]),
      [
        [200, "OK", "json"],
        [422, "Unprocessable Entity", "xml"],
        [404, "Not Found", "html"],
        [500, "Internal Server Error", "javascript"],
        [299, "", "text"],
      ],
    );
    assert.deepEqual(responses[0]!.originalRequest.header, [{ key: "X-On", value: "1" }]);
    assert.deepEqual(responses[0]!.originalRequest.body?.options, { raw: { language: "xml" } });
    assert.equal(responses[1]!.originalRequest.body, undefined);
    assert.equal(responses[0]!.header.length, 1);
  });
});

describe("entornos", () => {
  test("id por defecto, variables apagadas y baseUrl añadida solo si no existe ya", () => {
    const exported = toPostmanExport(
      bundle({
        environments: [
          {
            name: "local",
            baseUrl: "http://local",
            specUrl: null,
            variables: { a: { initial: "1", sensitive: false } },
            disabledVariables: { b: { initial: "2", sensitive: false } },
          },
          {
            name: "prod",
            baseUrl: "http://prod",
            specUrl: null,
            variables: { baseUrl: { initial: "http://otra", sensitive: false } },
            disabledVariables: { k: { initial: "s", sensitive: true } },
          },
          { name: "vacío", baseUrl: "", specUrl: null, variables: {}, disabledVariables: {} },
        ],
      }),
      { collectionId: "col", environmentIds: ["env-a"] },
      { environments: true },
    );
    const [local, prod, empty] = exported.environments;
    assert.equal(local!.id, "env-a");
    assert.equal(prod!.id, "col-1");
    assert.equal(empty!.id, "col-2");
    assert.deepEqual(local!.values, [
      { key: "baseUrl", value: "http://local", type: "default", enabled: true },
      { key: "a", value: "1", type: "default", enabled: true },
      { key: "b", value: "2", type: "default", enabled: false },
    ]);
    assert.deepEqual(prod!.values, [
      { key: "baseUrl", value: "http://otra", type: "default", enabled: true },
      { key: "k", value: "", type: "secret", enabled: false },
    ]);
    assert.deepEqual(empty!.values, []);
    assert.equal(local!._postman_variable_scope, "environment");
  });

  test("sin entornos en el proyecto, pedirlos da una lista vacía", () => {
    assert.deepEqual(toPostmanExport(bundle(), IDS, { environments: true }).environments, []);
  });
});

describe("el traductor de comprobaciones", () => {
  const one = (check: Record<string, unknown>) => checkLines([check as never]);

  test("el estado con otro operador usa `pm.response.code`; uno no numérico cae a 0", () => {
    assert.equal(
      one({ source: "status", operator: "less_than", value: 400 })[1],
      "  pm.expect(pm.response.code).to.be.below(400);",
    );
    assert.equal(one({ source: "status", operator: "equals", value: "abc" })[1], "  pm.response.to.have.status(0);");
  });

  test("cada operador restante dice su chai", () => {
    const tail = (operator: string, value?: unknown) =>
      one({ source: "body", path: "a", operator, value })[1];
    assert.equal(tail("not_contains", "x"), '  pm.expect(pm.response.json().a).to.not.include("x");');
    assert.equal(tail("matches"), '  pm.expect(pm.response.json().a).to.match(new RegExp(""));');
    assert.equal(tail("has_length", "z"), "  pm.expect(pm.response.json().a).to.have.lengthOf(0);");
    assert.equal(tail("greater_than", "z"), "  pm.expect(pm.response.json().a).to.be.above(0);");
    assert.equal(tail("less_than", 3), "  pm.expect(pm.response.json().a).to.be.below(3);");
    assert.equal(tail("less_than", "z"), "  pm.expect(pm.response.json().a).to.be.below(0);");
    assert.equal(tail("not_equals"), "  pm.expect(pm.response.json().a).to.not.eql(null);");
  });

  test("un operador que chai no conoce cae a `eql` con el valor", () => {
    assert.equal(
      one({ source: "body", operator: "desconocido", value: 5 })[1],
      "  pm.expect(pm.response.json()).to.eql(5);",
    );
    assert.equal(one({ source: "body", operator: "raro" })[1], "  pm.expect(pm.response.json()).to.eql(null);");
  });

  test("el título: etiqueta si la hay; si no, uno con el sujeto y el valor", () => {
    assert.equal(one({ label: "Mío", source: "status", operator: "exists" })[0], 'pm.test("Mío", function () {');
    assert.equal(
      one({ source: "header", operator: "exists" })[0],
      'pm.test("la cabecera  exists", function () {',
    );
    assert.equal(one({ source: "header", operator: "exists" })[1], '  pm.expect(pm.response.headers.get("")).to.exist;');
    assert.equal(one({ source: "body", operator: "is_array" })[0], 'pm.test("el cuerpo is array", function () {');
    assert.equal(
      one({ source: "durationMs", operator: "less_than", value: 100 })[0],
      'pm.test("la duración less than 100", function () {',
    );
  });

  test("una captura de expresión usa la primera captura del texto; un camino vacío lee el cuerpo entero", () => {
    assert.deepEqual(captureLines([{ variable: "id", from: "regex", path: "id=(\\d+)" } as never]), [
      'pm.collectionVariables.set("id", (pm.response.text().match(new RegExp("id=(\\\\d+)")) || [])[1]);',
    ]);
    assert.deepEqual(captureLines([{ variable: "todo", from: "body", path: "" } as never]), [
      'pm.collectionVariables.set("todo", pm.response.json());',
    ]);
  });
});
