/**
 * The corners of `exampleFromSchema` the main suite does not walk: `examples`, type lists,
 * booleans and nulls, schemas that describe nothing buildable, and the numeric bounds.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { exampleFromSchema } from "../src/example.ts";

describe("exampleFromSchema: lo que declara el documento", () => {
  test("la primera entrada de examples gana; una lista vacía no dice nada", () => {
    assert.equal(exampleFromSchema({ type: "string", examples: ["ACME-1", "ACME-2"] }), "ACME-1");
    assert.equal(exampleFromSchema({ type: "string", examples: [] }), "ejemplo");
  });

  test("una lista de tipos usa el primero que no es null", () => {
    assert.equal(exampleFromSchema({ type: ["null", "integer"] }), 1);
    assert.equal(exampleFromSchema({ type: ["null"] }), undefined);
  });

  test("boolean da true y null da null", () => {
    assert.equal(exampleFromSchema({ type: "boolean" }), true);
    assert.equal(exampleFromSchema({ type: "null" }), null);
  });
});

describe("exampleFromSchema: lo que no se puede construir", () => {
  test("un objeto sin propiedades, o con propiedades que no son un objeto, no da cuerpo", () => {
    assert.equal(exampleFromSchema({ type: "object" }), undefined);
    assert.equal(exampleFromSchema({ type: "object", properties: 5 }), undefined);
  });

  test("una propiedad nula no se inventa", () => {
    assert.deepEqual(exampleFromSchema({ type: "object", properties: { vacio: null, nombre: { type: "string" } } }), {
      nombre: "ejemplo",
    });
    assert.equal(exampleFromSchema({ type: "object", properties: { vacio: null } }), undefined);
  });

  test("un array cuyos elementos no se pueden construir no da un array vacío", () => {
    assert.equal(exampleFromSchema({ type: "array" }), undefined);
    assert.equal(exampleFromSchema({ type: "array", items: {} }), undefined);
  });
});

describe("exampleFromSchema: límites numéricos", () => {
  test("exclusiveMinimum queda justo por encima: un entero más, o una centésima", () => {
    assert.equal(exampleFromSchema({ type: "integer", exclusiveMinimum: 5 }), 6);
    assert.equal(exampleFromSchema({ type: "number", exclusiveMinimum: 5 }), 5.01);
  });

  test("minimum pesa más que exclusiveMinimum", () => {
    assert.equal(exampleFromSchema({ type: "integer", minimum: 3, exclusiveMinimum: 5 }), 3);
  });

  test("un maximum por debajo de 1 recorta el valor por defecto", () => {
    assert.equal(exampleFromSchema({ type: "integer", maximum: 0 }), 0);
  });

  test("multipleOf redondea hacia arriba cuando cabe y hacia abajo cuando se pasaría del máximo", () => {
    assert.equal(exampleFromSchema({ type: "integer", minimum: 7, maximum: 12, multipleOf: 5 }), 10);
    assert.equal(exampleFromSchema({ type: "integer", minimum: 7, multipleOf: 5 }), 10);
    // 0.5 recortado, redondeado arriba a 0.6, se pasaría: baja al múltiplo anterior.
    assert.equal(exampleFromSchema({ type: "number", maximum: 0.5, multipleOf: 0.2 }), 0.4);
  });
});
