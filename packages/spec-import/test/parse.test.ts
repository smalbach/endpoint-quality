/**
 * The importer against documents that are not the one it was built for.
 *
 * The parity suite proves it reproduces the Python generator on Digital Catalog's contract. That
 * is necessary and not sufficient: a parser tuned to one well-formed document is exactly the
 * coupling being removed. These cases are the imperfect specs the tool will actually meet —
 * missing `operationId`, a path item shared across methods, `security: []`, Swagger 2.0, a
 * `$ref` that was never bundled.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { deriveOperationId, importSpec, parseDocument } from "../src/parse.ts";
import { diffOperations } from "../src/drift.ts";
import { fingerprint } from "../src/fingerprint.ts";

const minimal = {
  openapi: "3.1.0",
  info: { title: "Blog", version: "2.0.0" },
  security: [{ bearerAuth: [] }],
  paths: {
    "/posts": {
      get: { operationId: "listPosts", summary: "List", tags: ["Posts"], parameters: [{ name: "author", in: "query" }], responses: { "200": {}, "401": {} } },
      post: { operationId: "createPost", tags: ["Posts"], responses: { "201": {}, "422": {} } },
    },
    "/posts/{slug}": {
      parameters: [{ name: "slug", in: "path" }],
      get: { operationId: "getPost", responses: { "200": {}, "404": {} } },
      delete: { operationId: "deletePost", responses: { "204": {} } },
    },
  },
};

const asYaml = `
openapi: 3.0.3
info: { title: Y, version: "1" }
paths:
  /a:
    get:
      operationId: getA
      responses:
        "200": {}
`;

describe("lectura del documento", () => {
  test("acepta JSON y YAML", () => {
    assert.equal(importSpec(JSON.stringify(minimal)).operations.length, 4);
    // OpenAPI documents are served as both, and telling them apart by extension fails on a URL
    // that has none.
    assert.equal(importSpec(asYaml).operations.length, 1);
  });

  test("un JSON roto falla con el error del parser, no en silencio", () => {
    assert.throws(() => parseDocument('{"openapi": '), /no es JSON válido/);
  });

  test("un documento sin versión de OpenAPI es un error de importación", () => {
    const problems = importSpec(JSON.stringify({ info: {}, paths: {} })).problems;
    assert.ok(problems.some((problem) => problem.severity === "error" && problem.pointer === "#/openapi"));
  });

  test("Swagger 2.0 se rechaza en vez de leerse a medias", () => {
    // A different document shape, not an older spelling of the same one: reading it here would
    // produce an operation table with no schemas attached and no sign that anything was lost.
    const problems = importSpec(JSON.stringify({ swagger: "2.0", info: {}, paths: {} })).problems;
    assert.ok(problems.some((problem) => problem.severity === "error" && /Swagger 2.0/.test(problem.message)));
  });

  test("un documento sin rutas avisa en lugar de devolver una matriz vacía sin explicación", () => {
    const spec = importSpec(JSON.stringify({ openapi: "3.1.0", info: {} }));
    assert.deepEqual(spec.operations, []);
    assert.ok(spec.problems.some((problem) => problem.pointer === "#/paths"));
  });
});

describe("operaciones", () => {
  const spec = importSpec(JSON.stringify(minimal));

  test("ordena por ruta y después por método, en orden de codepoint", () => {
    assert.deepEqual(spec.operations.map((operation) => operation.id), ["listPosts", "createPost", "deletePost", "getPost"]);
  });

  test("el parámetro compartido de la ruta llega a las dos operaciones", () => {
    for (const id of ["getPost", "deletePost"]) {
      assert.deepEqual(spec.operations.find((operation) => operation.id === id)!.parameters, ["slug"]);
    }
  });

  test("los compartidos van antes que los propios de la operación", () => {
    const withBoth = importSpec(
      JSON.stringify({
        openapi: "3.1.0", info: {},
        paths: { "/x/{id}": { parameters: [{ name: "id", in: "path" }], get: { operationId: "g", parameters: [{ name: "q", in: "query" }], responses: { "200": {} } } } },
      }),
    );
    assert.deepEqual(withBoth.operations[0].parameters, ["id", "q"]);
  });

  test("los estados llegan como números ordenados y sin los no numéricos", () => {
    const spec = importSpec(
      JSON.stringify({ openapi: "3.1.0", info: {}, paths: { "/x": { get: { operationId: "g", responses: { "404": {}, "200": {}, default: {}, "4XX": {} } } } } }),
    );
    // `default` and `4XX` are real OpenAPI and cannot be asserted against: a case needs a
    // specific status to expect.
    assert.deepEqual(spec.operations[0].statuses, [200, 404]);
  });

  test("una operación sin estados declarados avisa: no generará ningún caso", () => {
    const spec = importSpec(JSON.stringify({ openapi: "3.1.0", info: {}, paths: { "/x": { get: { operationId: "g", responses: {} } } } }));
    assert.ok(spec.problems.some((problem) => /no generará casos/.test(problem.message)));
  });

  test("un tag ausente no rompe la importación", () => {
    assert.equal(importSpec(JSON.stringify(minimal)).operations.find((operation) => operation.id === "getPost")!.tag, "");
  });
});

describe("operationId ausente", () => {
  const spec = importSpec(
    JSON.stringify({ openapi: "3.1.0", info: {}, paths: { "/v1/stores/{store_id}/assortment": { get: { responses: { "200": {} } } } } }),
  );

  test("se deriva un id estable del método y la ruta", () => {
    // `operationId` is optional in OpenAPI and plenty of real documents omit it. Without an id
    // there is nothing to key configuration by.
    assert.equal(spec.operations[0].id, "get-v1-stores-by-store_id-assortment");
    assert.equal(deriveOperationId("get", "/v1/stores/{store_id}/assortment"), spec.operations[0].id);
  });

  test("queda marcado como derivado, porque no es el nombre del contrato", () => {
    // Configuration keyed by a derived id breaks the day the author adds a real one, so the
    // caller has to be able to see which ids are borrowed.
    assert.equal(spec.operations[0].derivedId, true);
    assert.ok(spec.problems.some((problem) => problem.severity === "warning" && /Sin operationId/.test(problem.message)));
  });

  test("dos operaciones con el mismo operationId: la segunda se rechaza y se reporta", () => {
    // Two operations under one id would share configuration silently, and the second would
    // overwrite the first's verdict in every view keyed by it.
    const duplicated = importSpec(
      JSON.stringify({ openapi: "3.1.0", info: {}, paths: { "/a": { get: { operationId: "same", responses: { "200": {} } } }, "/b": { get: { operationId: "same", responses: { "200": {} } } } } }),
    );
    assert.equal(duplicated.operations.length, 1);
    assert.ok(duplicated.problems.some((problem) => problem.severity === "error" && /duplicado/.test(problem.message)));
  });
});

describe("seguridad", () => {
  test("una operación sin security hereda la del documento", () => {
    assert.deepEqual(importSpec(JSON.stringify(minimal)).operations.find((operation) => operation.id === "getPost")!.security, ["bearerAuth"]);
  });

  test("security: [] significa pública y no hereda nada", () => {
    // The presence of the key decides, not its emptiness: an explicit empty array is how a spec
    // says "this one endpoint needs no credential", and falling back to the default would
    // generate 401 cases against a health probe.
    const spec = importSpec(
      JSON.stringify({ openapi: "3.1.0", info: {}, security: [{ bearerAuth: [] }], paths: { "/health": { get: { operationId: "h", security: [], responses: { "200": {} } } } } }),
    );
    assert.deepEqual(spec.operations[0].security, []);
  });
});

describe("$ref", () => {
  test("un parámetro por referencia local se resuelve", () => {
    const spec = importSpec(
      JSON.stringify({
        openapi: "3.1.0", info: {},
        components: { parameters: { StoreId: { name: "store_id", in: "path" } } },
        paths: { "/s/{store_id}": { parameters: [{ $ref: "#/components/parameters/StoreId" }], get: { operationId: "g", responses: { "200": {} } } } },
      }),
    );
    assert.deepEqual(spec.operations[0].parameters, ["store_id"]);
  });

  test("una referencia a otro fichero se reporta en vez de ir a buscarla", () => {
    // Resolving it would mean fetching whatever URL the document names, which turns importing a
    // spec into a request forger pointed at the importer's own network.
    const spec = importSpec(
      JSON.stringify({ openapi: "3.1.0", info: {}, paths: { "/s": { get: { operationId: "g", parameters: [{ $ref: "./common.yaml#/Foo" }], responses: { "200": {} } } } } }),
    );
    assert.deepEqual(spec.operations[0].parameters, []);
    assert.ok(spec.problems.some((problem) => /sin empaquetar/.test(problem.message)));
  });

  test("una referencia circular no cuelga la importación", () => {
    const spec = importSpec(
      JSON.stringify({
        openapi: "3.1.0", info: {},
        components: { parameters: { A: { $ref: "#/components/parameters/B" }, B: { $ref: "#/components/parameters/A" } } },
        paths: { "/s": { get: { operationId: "g", parameters: [{ $ref: "#/components/parameters/A" }], responses: { "200": {} } } } },
      }),
    );
    assert.deepEqual(spec.operations[0].parameters, []);
  });
});

describe("drift entre dos versiones", () => {
  const before = importSpec(JSON.stringify(minimal)).operations;

  test("dos importaciones del mismo documento no reportan cambios", () => {
    assert.deepEqual(diffOperations(before, importSpec(JSON.stringify(minimal)).operations).changes, []);
  });

  test("una operación nueva es superficie sin cubrir, no un cambio rompedor", () => {
    const next = structuredClone(minimal) as typeof minimal & { paths: Record<string, unknown> };
    next.paths["/comments"] = { get: { operationId: "listComments", responses: { "200": {} } } };
    const drift = diffOperations(before, importSpec(JSON.stringify(next)).operations);
    assert.equal(drift.breaking.length, 0);
    assert.equal(drift.uncovered.length, 1);
    assert.deepEqual(drift.uncovered[0], { kind: "added", id: "listComments", method: "GET", path: "/comments" });
  });

  test("una operación que desaparece sí es rompedora", () => {
    // Configuration keyed by it is now dead, and a run would assert something the contract no
    // longer promises.
    const next = structuredClone(minimal) as typeof minimal & { paths: Record<string, unknown> };
    delete next.paths["/posts/{slug}"];
    const drift = diffOperations(before, importSpec(JSON.stringify(next)).operations);
    assert.equal(drift.breaking.filter((change) => change.kind === "removed").length, 2);
  });

  test("una ruta que se mueve es un movimiento, no un alta más una baja", () => {
    // Matched by id, so the operator reads "getPost moved" instead of hunting through two
    // unrelated-looking entries.
    const next = structuredClone(minimal) as typeof minimal & { paths: Record<string, unknown> };
    next.paths["/articles/{slug}"] = next.paths["/posts/{slug}"];
    delete next.paths["/posts/{slug}"];
    const drift = diffOperations(before, importSpec(JSON.stringify(next)).operations);
    const moved = drift.changes.filter((change) => change.kind === "moved");
    assert.equal(moved.length, 2);
    assert.equal(drift.changes.some((change) => change.kind === "removed"), false);
  });

  test("un estado que deja de declararse invalida los casos que lo esperaban", () => {
    const next = structuredClone(minimal);
    next.paths["/posts"].get.responses = { "200": {} } as never;
    const drift = diffOperations(before, importSpec(JSON.stringify(next)).operations);
    assert.deepEqual(drift.breaking, [{ kind: "statuses", id: "listPosts", added: [], removed: [401] }]);
  });

  test("un cambio de esquema de seguridad siempre se marca como rompedor", () => {
    // It is the change most likely to be made without anybody thinking about the test matrix,
    // and it decides which authorization cases mean anything.
    const next = structuredClone(minimal);
    next.security = [{ apiKey: [] }];
    const drift = diffOperations(before, importSpec(JSON.stringify(next)).operations);
    assert.equal(drift.breaking.every((change) => change.kind === "security"), true);
    assert.equal(drift.breaking.length, 4);
  });
});

describe("huella del documento", () => {
  test("el mismo texto da la misma huella y un cambio la cambia", () => {
    const raw = JSON.stringify(minimal);
    assert.equal(fingerprint(raw), fingerprint(raw));
    assert.notEqual(fingerprint(raw), fingerprint(`${raw} `));
  });

  test("cubre cambios que no tocan ninguna operación", () => {
    // Two documents differing only in a description are still two documents. The operation-level
    // diff answers the narrower question of whether anything the engine cares about moved.
    const other = structuredClone(minimal);
    other.info.title = "Otro";
    assert.notEqual(fingerprint(JSON.stringify(minimal)), fingerprint(JSON.stringify(other)));
    assert.deepEqual(diffOperations(importSpec(JSON.stringify(minimal)).operations, importSpec(JSON.stringify(other)).operations).changes, []);
  });
});
