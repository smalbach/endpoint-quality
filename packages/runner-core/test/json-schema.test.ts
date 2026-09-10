import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { dereference, responseSchema, undeclaredPaths, validateJson } from "../src/json-schema.ts";

const spec = {
  components: {
    schemas: {
      Store: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          parent: { $ref: "#/components/schemas/Store" },
        },
      },
      StoreEnvelope: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Store" } },
      },
    },
  },
  paths: {
    "/v1/stores/{store_id}": {
      get: {
        responses: {
          "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/StoreEnvelope" } } } },
          "404": { content: { "application/problem+json": { schema: { type: "object", required: ["title"] } } } },
        },
      },
    },
  },
} as Record<string, unknown>;

test("un $ref recursivo se corta en vez de colgarse", () => {
  // A self-referencing node resolves to `{}`, which validates anything — the alternative is an
  // infinite loop inside the one assertion the whole tool exists for.
  const schema = dereference({ $ref: "#/components/schemas/Store" }, spec) as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  assert.deepEqual(properties.parent, {});
  assert.deepEqual((properties.id as Record<string, unknown>).type, "integer");
});

test("se recogen todos los fallos, no solo el primero", () => {
  const errors = validateJson({ id: "uno" }, dereference({ $ref: "#/components/schemas/Store" }, spec));
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.includes("$.name: campo requerido")));
  assert.ok(errors.some((error) => error.includes("$.id: tipo esperado integer")));
});

test("un valor conforme no produce errores", () => {
  assert.deepEqual(
    validateJson({ data: { id: 1, name: "Ara" } }, dereference({ $ref: "#/components/schemas/StoreEnvelope" }, spec)),
    [],
  );
});

test("integer y number no son lo mismo", () => {
  assert.equal(validateJson(1.5, { type: "integer" }).length, 1);
  assert.equal(validateJson(1.5, { type: "number" }).length, 0);
});

test("null es un tipo, no la ausencia de valor", () => {
  assert.equal(validateJson(null, { type: ["integer", "null"] }).length, 0);
  assert.equal(validateJson(null, { type: "integer" }).length, 1);
  // `meta.total` es un entero para una colección y null para otra: sin esto, la mitad de las
  // respuestas correctas se reportarían como rotas.
  assert.equal(
    validateJson({ total: null }, { type: "object", properties: { total: { type: ["integer", "null"] } } }).length,
    0,
  );
});

test("un array valida cada elemento y nombra el índice que falla", () => {
  const errors = validateJson([{ id: 1 }, { id: "dos" }], {
    type: "array",
    items: { type: "object", properties: { id: { type: "integer" } } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\$\[1\]\.id:/);
});

test("additionalProperties: false rechaza el campo de más", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  assert.equal(validateJson({ a: "x" }, schema).length, 0);
  assert.equal(validateJson({ a: "x", b: 1 }, schema).length, 1);
});

test("oneOf exige exactamente una alternativa", () => {
  const schema = { oneOf: [{ type: "string" }, { type: "integer" }] };
  assert.equal(validateJson("x", schema).length, 0);
  assert.equal(validateJson(true, schema).length, 1);
});

test("una palabra clave desconocida se ignora en vez de inventar un error", () => {
  // A validator that invents errors is worse than one that misses some: the first is noise the
  // operator has to disprove, the second is silence.
  assert.deepEqual(validateJson("x", { type: "string", format: "email", "x-vendor": true }), []);
});

test("el schema declarado se resuelve por operación, método, status y content type", () => {
  const ok = responseSchema(spec, "/v1/stores/{store_id}", "GET", 200) as Record<string, unknown>;
  assert.deepEqual(ok.required, ["data"]);
  const problem = responseSchema(
    spec,
    "/v1/stores/{store_id}",
    "GET",
    404,
    "application/problem+json; charset=utf-8",
  ) as Record<string, unknown>;
  assert.deepEqual(problem.required, ["title"]);
});

test("un status no declarado devuelve undefined, que no es un fallo", () => {
  // An API can answer 422 on a corrupt cursor without having declared it. That is a finding
  // about the contract, not about the response, and the caller checks the error envelope instead.
  assert.equal(responseSchema(spec, "/v1/stores/{store_id}", "GET", 422), undefined);
  assert.equal(responseSchema(spec, "/v1/nope", "GET", 200), undefined);
});

/**
 * La dirección que nadie comprueba.
 *
 * Un campo requerido que falta es una respuesta rota. Un campo de más es un contrato que se movió
 * sin que se moviera el documento, y el consumidor que empiece a depender de él depende de algo
 * que nadie prometió. Es un aviso, no un error: `additionalProperties: false` es lo que convierte
 * «no declarado» en «prohibido», y eso lo decide el esquema.
 */
describe("los campos que la respuesta trae de más", () => {
  const schema = {
    type: "object",
    properties: { id: { type: "number" }, name: { type: "string" } },
  };

  test("se nombran por su ruta", () => {
    assert.deepEqual(undeclaredPaths({ id: 1, name: "a", extra: true }, schema), ["$.extra"]);
  });

  test("no hay ninguno cuando la respuesta se ciñe a lo declarado", () => {
    assert.deepEqual(undeclaredPaths({ id: 1, name: "a" }, schema), []);
  });

  test("un objeto sin propiedades declaradas no dice nada de su contenido", () => {
    // Un esquema `{ type: "object" }` es libre a propósito; llamar deriva a cada uno de sus campos
    // sería ruido, no un hallazgo.
    assert.deepEqual(undeclaredPaths({ lo: 1, que: 2, sea: 3 }, { type: "object" }), []);
  });

  test("de una lista se mira el primer elemento y no los doscientos", () => {
    const list = { type: "array", items: schema };
    const rows = Array.from({ length: 200 }, () => ({ id: 1, name: "a", extra: true }));
    assert.deepEqual(undeclaredPaths(rows, list), ["$[0].extra"]);
  });

  test("allOf compone lo declarado: un campo de cualquier rama está declarado", () => {
    const composed = { allOf: [schema, { type: "object", properties: { extra: { type: "boolean" } } }] };
    assert.deepEqual(undeclaredPaths({ id: 1, extra: true }, composed), []);
  });

  test("con alternativas no se adivina", () => {
    // `anyOf` dice que la forma es una de varias y este validador no sabe cuál; llamar no
    // declarados a los campos de las otras ramas sería inventarse hallazgos.
    const either = { type: "object", properties: { id: { type: "number" } }, anyOf: [schema] };
    assert.deepEqual(undeclaredPaths({ id: 1, name: "a" }, either), []);
  });
});
