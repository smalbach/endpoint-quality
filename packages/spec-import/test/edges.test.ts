/**
 * The corners of an imperfect document the main suite does not reach: the request schema kept
 * for write cases, malformed nodes that must become problems rather than crashes, and the drift
 * of parameters with the one-line description a log or a CI comment prints.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { importSpec, parseDocument } from "../src/parse.ts";
import { describeChange, diffOperations, type OperationChange } from "../src/drift.ts";

type Doc = Record<string, unknown>;

/** One POST whose requestBody is `requestBody`, inside a document with `components`. */
const withBody = (requestBody: unknown, components: Doc = {}): unknown =>
  importSpec(
    JSON.stringify({
      openapi: "3.1.0",
      info: {},
      components,
      paths: { "/stores": { post: { operationId: "createStore", requestBody, responses: { "201": {} } } } },
    }),
  ).operations[0].requestSchema;

describe("el esquema del cuerpo de la petición", () => {
  test("se guarda con cada $ref de las hojas resuelto, también dentro de listas y con escapes ~1", () => {
    const schema = withBody(
      {
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", default: null },
                address: { $ref: "#/components/schemas/Address" },
                tags: { type: "array", items: { $ref: "#/components/schemas/a~1b" } },
                kind: { oneOf: [{ $ref: "#/components/schemas/Address" }, { type: "null" }] },
              },
            },
          },
        },
      },
      {
        schemas: {
          Address: { type: "object", properties: { city: { type: "string" } } },
          "a/b": { type: "string", enum: ["x"] },
        },
      },
    );
    assert.deepEqual(schema, {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", default: null },
        address: { type: "object", properties: { city: { type: "string" } } },
        tags: { type: "array", items: { type: "string", enum: ["x"] } },
        kind: { oneOf: [{ type: "object", properties: { city: { type: "string" } } }, { type: "null" }] },
      },
    });
  });

  test("un requestBody por referencia a components/requestBodies se sigue", () => {
    const schema = withBody(
      { $ref: "#/components/requestBodies/Store" },
      { requestBodies: { Store: { content: { "application/json": { schema: { type: "object" } } } } } },
    );
    assert.deepEqual(schema, { type: "object" });
  });

  test("acepta application/json con charset y los tipos de proveedor +json", () => {
    for (const type of ["application/json; charset=utf-8", "Application/vnd.acme.v2+json"])
      assert.deepEqual(withBody({ content: { [type]: { schema: { type: "integer" } } } }), { type: "integer" }, type);
  });

  test("un cuerpo que no es JSON no inventa esquema", () => {
    assert.equal(withBody({ content: { "multipart/form-data": { schema: { type: "object" } } } }), null);
    assert.equal(withBody({ content: { "text/csv": {} } }), null);
  });

  test("sin requestBody, sin content o sin schema no hay esquema", () => {
    assert.equal(withBody(undefined), null);
    assert.equal(withBody({ description: "sin content" }), null);
    assert.equal(withBody({ content: "application/json" }), null, "un content que no es objeto se ignora");
    assert.equal(withBody({ content: { "application/json": {} } }), null);
  });

  test("un $ref del esquema que no apunta a nada queda en null, no en undefined", () => {
    assert.equal(
      withBody({ content: { "application/json": { schema: { $ref: "#/components/schemas/Nope" } } } }),
      null,
    );
  });

  test("un esquema recursivo se corta en {} y una referencia externa también", () => {
    const schema = withBody(
      {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                category: { $ref: "#/components/schemas/Category" },
                external: { $ref: "./common.yaml#/Thing" },
              },
            },
          },
        },
      },
      {
        schemas: {
          Category: { type: "object", properties: { parent: { $ref: "#/components/schemas/Category" } } },
        },
      },
    );
    assert.deepEqual(schema, {
      type: "object",
      properties: {
        category: { type: "object", properties: { parent: {} } },
        external: {},
      },
    });
  });
});

describe("documentos malformados", () => {
  test("un YAML que no es un objeto en la raíz se rechaza", () => {
    assert.throws(() => parseDocument("solo un texto"), /no contiene un objeto/);
    assert.throws(() => parseDocument(""), /no contiene un objeto/);
  });

  test("sin info, el título y la versión quedan vacíos en vez de fallar", () => {
    const spec = importSpec(JSON.stringify({ openapi: "3.1.0", paths: {} }));
    assert.equal(spec.title, "");
    assert.equal(spec.version, "");
  });

  test("una ruta que es una referencia rota se avisa y el resto se importa", () => {
    const spec = importSpec(
      JSON.stringify({
        openapi: "3.1.0",
        info: {},
        paths: {
          "/rota": { $ref: "#/components/pathItems/Nope" },
          "/buena": { get: { operationId: "ok", responses: { "200": {} } } },
        },
      }),
    );
    assert.deepEqual(
      spec.operations.map((operation) => operation.id),
      ["ok"],
    );
    assert.ok(
      spec.problems.some(
        (problem) => problem.pointer === "#/paths//rota" && /No se pudo resolver/.test(problem.message),
      ),
    );
  });

  test("una operación sin responses avisa como una con responses vacío", () => {
    const spec = importSpec(
      JSON.stringify({ openapi: "3.1.0", info: {}, paths: { "/x": { get: { operationId: "g" } } } }),
    );
    assert.deepEqual(spec.operations[0].statuses, []);
    assert.ok(spec.problems.some((problem) => /no generará casos/.test(problem.message)));
  });

  test("un requisito de seguridad que no es objeto se ignora sin perder los demás", () => {
    const spec = importSpec(
      JSON.stringify({
        openapi: "3.1.0",
        info: {},
        paths: {
          "/x": { get: { operationId: "g", security: [null, "bearer", { apiKey: [] }], responses: { "200": {} } } },
        },
      }),
    );
    assert.deepEqual(spec.operations[0].security, ["apiKey"]);
  });
});

describe("drift de parámetros", () => {
  const doc = (parameters: string[], statuses = ["200"]): Doc => ({
    openapi: "3.1.0",
    info: {},
    paths: {
      "/x": {
        get: {
          operationId: "g",
          parameters: parameters.map((name) => ({ name, in: "query" })),
          responses: Object.fromEntries(statuses.map((status) => [status, {}])),
        },
      },
    },
  });
  const drift = (before: string[], after: string[]) =>
    diffOperations(
      importSpec(JSON.stringify(doc(before))).operations,
      importSpec(JSON.stringify(doc(after))).operations,
    );

  test("un parámetro nuevo es superficie sin cubrir y no rompe", () => {
    const result = drift(["a"], ["a", "b"]);
    assert.deepEqual(result.changes, [{ kind: "parameters", id: "g", added: ["b"], removed: [] }]);
    assert.deepEqual(result.breaking, []);
    assert.equal(result.uncovered.length, 1);
  });

  test("un parámetro que desaparece rompe y no es superficie nueva", () => {
    const result = drift(["a", "b"], ["a"]);
    assert.equal(result.breaking.length, 1);
    assert.deepEqual(result.uncovered, []);
  });

  test("un estado nuevo es superficie sin cubrir y no rompe", () => {
    const before = importSpec(JSON.stringify(doc([]))).operations;
    const result = diffOperations(before, importSpec(JSON.stringify(doc([], ["200", "404"]))).operations);
    assert.deepEqual(result.breaking, []);
    assert.deepEqual(result.uncovered, [{ kind: "statuses", id: "g", added: [404], removed: [] }]);
  });
});

describe("la línea que describe cada cambio", () => {
  test("cada tipo de cambio tiene su prefijo y su forma", () => {
    const cases: [OperationChange, string][] = [
      [{ kind: "added", id: "g", method: "GET", path: "/x" }, "+ GET /x (g)"],
      [{ kind: "removed", id: "g", method: "DELETE", path: "/x/{id}" }, "- DELETE /x/{id} (g)"],
      [{ kind: "moved", id: "g", from: "GET /a", to: "GET /b" }, "~ g: GET /a → GET /b"],
      [{ kind: "statuses", id: "g", added: [404, 409], removed: [401] }, "~ g: estados +404, +409 -401"],
      [{ kind: "statuses", id: "g", added: [], removed: [401] }, "~ g: estados -401"],
      [{ kind: "parameters", id: "g", added: ["q"], removed: [] }, "~ g: parámetros +q"],
      [{ kind: "security", id: "g", from: ["bearer"], to: [] }, "~ g: seguridad [bearer] → []"],
    ];
    for (const [change, line] of cases) assert.equal(describeChange(change), line);
  });
});
