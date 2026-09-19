/**
 * The corners of the validator the main suite does not walk: composition keywords, `enum`, a
 * missing schema and a document without `paths`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { responseSchema, undeclaredPaths, validateJson } from "../src/json-schema.ts";

describe("validateJson: composición y enum", () => {
  test("sin esquema no hay nada que validar", () => {
    assert.deepEqual(validateJson({ lo: "que sea" }, undefined), []);
    assert.deepEqual(validateJson(1, null), []);
  });

  test("allOf exige cada rama y reporta los fallos de todas", () => {
    const schema = { allOf: [{ type: "object", required: ["id"] }, { type: "object", required: ["nombre"] }] };
    assert.deepEqual(validateJson({ id: 1, nombre: "a" }, schema), []);
    assert.deepEqual(validateJson({}, schema), ["$.id: campo requerido", "$.nombre: campo requerido"]);
  });

  test("anyOf pasa con una rama cualquiera y falla si no coincide ninguna", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "integer" }] };
    assert.deepEqual(validateJson("a", schema), []);
    assert.deepEqual(validateJson(2, schema), []);
    assert.deepEqual(validateJson(true, schema, "$.activo"), ["$.activo: no coincide con ninguna alternativa"]);
  });

  test("oneOf falla tanto si no coincide ninguna como si coinciden dos", () => {
    const schema = { oneOf: [{ type: "number" }, { type: "integer" }] };
    assert.deepEqual(validateJson(1.5, schema), []);
    assert.deepEqual(validateJson(1, schema), ["$: debe coincidir con una alternativa"]);
    assert.deepEqual(validateJson("x", schema), ["$: debe coincidir con una alternativa"]);
  });

  test("enum compara por valor, también objetos", () => {
    const schema = { enum: ["activo", { modo: "b" }] };
    assert.deepEqual(validateJson("activo", schema), []);
    assert.deepEqual(validateJson({ modo: "b" }, schema), []);
    assert.deepEqual(validateJson("baja", schema, "$.estado"), ["$.estado: valor fuera del enum"]);
  });
});

describe("responseSchema y undeclaredPaths sin declaración", () => {
  test("un documento sin paths no declara ninguna respuesta", () => {
    assert.equal(responseSchema({}, "/stores", "GET", 200), undefined);
  });

  test("sin esquema no hay campos no declarados que reportar", () => {
    assert.deepEqual(undeclaredPaths({ extra: 1 }, undefined), []);
    assert.deepEqual(undeclaredPaths({ extra: 1 }, "no es un esquema"), []);
  });
});
