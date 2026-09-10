/**
 * The request body derived from the contract.
 *
 * This is what makes the product work when you *point* it at a project rather than after you
 * configure one. Before it, an operation with no `bodies` entry sent nothing, and every POST, PUT
 * and PATCH came back 422 — a wall of red that says nothing about the API and everything about a
 * missing payload.
 *
 * Two properties matter more than the individual values. It is **deterministic**, because a body
 * that changes between runs makes two runs incomparable and a failure irreproducible. And it never
 * returns an empty object, because an empty object *is* the invalid-body case: returning one here
 * would make the create case and the invalid-body case send the same payload and expect opposite
 * answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { exampleFromSchema } from "../src/example.ts";
import { defineProjectConfig } from "../src/config.ts";
import { resolveOperation } from "../src/scenarios.ts";
import type { Operation } from "../src/types.ts";

test("lo que el documento dice gana a cualquier cosa que se pueda inventar", () => {
  // `example`, `default`, `const`, `enum`: cada uno es el autor diciendo qué mandar.
  assert.deepEqual(exampleFromSchema({ type: "object", example: { listo: true } }), { listo: true });
  assert.equal(exampleFromSchema({ type: "string", default: "por-defecto" }), "por-defecto");
  assert.equal(exampleFromSchema({ type: "string", const: "fijo" }), "fijo");
  assert.equal(exampleFromSchema({ type: "string", enum: ["alfa", "beta"] }), "alfa");
});

test("los obligatorios siempre; los opcionales solo si el documento les dio valor", () => {
  // The minimal valid payload is the one most likely to be accepted. Inventing values for optional
  // fields gives the API more surface to reject, and a 422 caused by a field nobody asked for
  // reads as a fault in the endpoint.
  const body = exampleFromSchema({
    type: "object",
    required: ["nombre"],
    properties: {
      nombre: { type: "string" },
      apodo: { type: "string" },
      color: { type: "string", default: "azul" },
    },
  });
  assert.deepEqual(body, { nombre: "ejemplo", color: "azul" });
});

test("si el schema no exige nada, se mandan todos los campos que declara", () => {
  // Declararlo todo opcional es lo que *es* un PATCH. El payload mínimo válido de ese schema es
  // `{}`, que es no mandar nada, y a eso varias APIs responden 422 con razón. El documento ya dijo
  // que la operación acepta esos campos; y una mutación que cambia todos es lo que hace que la
  // relectura posterior valga algo.
  const body = exampleFromSchema({
    type: "object",
    properties: { nombre: { type: "string" }, color: { type: "string" }, stock: { type: "integer" } },
  });
  assert.deepEqual(body, { nombre: "ejemplo", color: "ejemplo", stock: 1 });
});

test("un campo readOnly no viaja en la petición", () => {
  // OpenAPI says a `readOnly` field must not be sent in a request. An API that validates strictly
  // answers 422 to one that is, which would be this tool causing the failure it reports.
  const body = exampleFromSchema({
    type: "object",
    required: ["id", "nombre"],
    properties: { id: { type: "integer", readOnly: true }, nombre: { type: "string" } },
  });
  assert.deepEqual(body, { nombre: "ejemplo" });
});

test("cada formato de string trae un valor que ese formato acepta", () => {
  const value = (format: string) => exampleFromSchema({ type: "string", format });
  assert.equal(value("date-time"), "2024-01-01T00:00:00Z");
  assert.equal(value("date"), "2024-01-01");
  assert.equal(value("email"), "ejemplo@example.com");
  assert.equal(value("uuid"), "00000000-0000-4000-8000-000000000000");
  assert.equal(value("uri"), "https://example.com/ejemplo");
  // Sin formato, un marcador que se ve que lo es. Si aparece en los logs de alguien, "ejemplo" es
  // mejor hallazgo que un nombre plausible que se confunda con un dato real.
  assert.equal(value(""), "ejemplo");
});

test("minLength y maxLength se respetan, y en ese orden", () => {
  // A value that fails the very constraint the contract published would be this tool writing the
  // 422 itself.
  assert.equal(exampleFromSchema({ type: "string", minLength: 12 }), "ejemplo-----");
  assert.equal(exampleFromSchema({ type: "string", maxLength: 3 }), "eje");
  assert.equal(exampleFromSchema({ type: "string", minLength: 10, maxLength: 10 }), "ejemplo---");
});

test("los números caen dentro del rango declarado", () => {
  // 1 y no 0: una cantidad o un precio de cero es un número válido y un payload sospechoso, y
  // muchos contratos declaran `minimum: 1` sin decirlo.
  assert.equal(exampleFromSchema({ type: "integer" }), 1);
  assert.equal(exampleFromSchema({ type: "integer", minimum: 10 }), 10);
  assert.equal(exampleFromSchema({ type: "integer", exclusiveMinimum: 10 }), 11);
  assert.equal(exampleFromSchema({ type: "number", minimum: 0, maximum: 0 }), 0);
  assert.equal(exampleFromSchema({ type: "number", multipleOf: 0.5, minimum: 1.2 }), 1.5);
  // Sin esto saldría 0.30000000000000004 y fallaría un validador por un motivo ajeno a la API.
  assert.equal(exampleFromSchema({ type: "number", multipleOf: 0.1, minimum: 0.25 }), 0.3);
});

test("un array trae al menos los elementos que el contrato exige", () => {
  assert.deepEqual(exampleFromSchema({ type: "array", items: { type: "string" } }), ["ejemplo"]);
  // Un endpoint bulk que pide dos filas como mínimo respondería 422 sobre el array y no sobre el
  // payload si le mandáramos una.
  assert.deepEqual(exampleFromSchema({ type: "array", items: { type: "integer" }, minItems: 3 }), [1, 1, 1]);
});

test("allOf se compone y oneOf elige, saltándose la rama nula", () => {
  const composed = exampleFromSchema({
    allOf: [
      { type: "object", required: ["a"], properties: { a: { type: "string" } } },
      { type: "object", required: ["b"], properties: { b: { type: "integer" } } },
    ],
  });
  assert.deepEqual(composed, { a: "ejemplo", b: 1 });

  // `anyOf: [{…}, {type: null}]` es como se escribe "puede ser nulo". Contestar `null` dejaría un
  // campo obligatorio vacío sin motivo.
  assert.equal(exampleFromSchema({ anyOf: [{ type: "null" }, { type: "string" }] }), "ejemplo");
});

test("un schema recursivo termina", () => {
  // Una categoría cuyo padre es una categoría es un schema perfectamente normal. La alternativa a
  // parar es no parar.
  const category: Record<string, unknown> = {
    type: "object",
    required: ["nombre"],
    properties: { nombre: { type: "string" } },
  };
  (category.properties as Record<string, unknown>).padre = category;
  (category.required as string[]).push("padre");
  const body = exampleFromSchema(category) as Record<string, unknown>;
  assert.equal(body.nombre, "ejemplo");
  assert.equal(typeof JSON.stringify(body), "string", "un ciclo sin cortar no se puede ni serializar");
});

test("nunca devuelve un objeto vacío, que es el caso invalid-body", () => {
  assert.equal(exampleFromSchema({ type: "object", properties: {} }), undefined);
  assert.equal(
    exampleFromSchema({ type: "object", properties: { id: { type: "integer", readOnly: true } }, required: ["id"] }),
    undefined,
  );
  assert.equal(exampleFromSchema(null), undefined);
  assert.equal(exampleFromSchema({}), undefined);
});

test("es determinista: dos llamadas, el mismo cuerpo", () => {
  const schema = {
    type: "object",
    required: ["nombre", "cantidad"],
    properties: { nombre: { type: "string" }, cantidad: { type: "integer" } },
  };
  assert.deepEqual(exampleFromSchema(schema), exampleFromSchema(schema));
});

const createStore: Operation = {
  id: "createStore",
  method: "POST",
  path: "/stores",
  summary: "",
  tag: "Stores",
  statuses: [201, 422],
  parameters: [],
  requestSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
};

test("la configuración manda sobre el contrato", () => {
  // A schema says what is structurally valid; a project knows what is acceptable — which store
  // exists, which name is taken. The derived example fills a silence, it does not overrule anyone.
  const config = defineProjectConfig({
    bodyTemplates: { createStore: { body: { name: "Tienda de la configuración" } } },
  });
  assert.deepEqual(resolveOperation(createStore, config).body, { name: "Tienda de la configuración" });
});

test("y sin configuración el contrato basta para tener cuerpo", () => {
  assert.deepEqual(resolveOperation(createStore, defineProjectConfig({})).body, { name: "ejemplo" });
});

test("una operación sin requestBody sigue sin cuerpo", () => {
  const { requestSchema: _ignored, ...withoutSchema } = createStore;
  assert.equal(resolveOperation(withoutSchema, defineProjectConfig({})).body, undefined);
});
