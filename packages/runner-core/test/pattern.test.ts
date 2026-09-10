/**
 * The `pattern` a contract publishes, honoured.
 *
 * Every generated value is asserted against the real `RegExp` as well as against the expected
 * string, because the expected string is this file's opinion and the regular expression is the
 * contract's. When the two disagree, the contract is right.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { exampleFromPattern } from "../src/pattern.ts";
import { exampleFromSchema } from "../src/example.ts";

/** Generated, and then checked against the pattern it claims to satisfy. */
function satisfying(pattern: string, minLength = 0): string | undefined {
  const value = exampleFromPattern(pattern, minLength);
  if (value !== undefined) assert.match(value, new RegExp(pattern), `«${value}» no cumple ${pattern}`);
  return value;
}

test("clases, rangos y repeticiones contadas", () => {
  assert.equal(satisfying("^[A-Z]{3}-\\d{4}$"), "AAA-0000");
  assert.equal(satisfying("^\\d{13}$"), "0000000000000");
  assert.equal(satisfying("^[a-z0-9-]+$"), "a");
  assert.equal(satisfying("^v\\d+\\.\\d+$"), "v0.0");
});

test("alternancia elige la primera rama que se pueda construir", () => {
  assert.equal(satisfying("^(rojo|verde|azul)$"), "rojo");
  // La primera usa una retrorreferencia, que no se implementa; la segunda sirve igual.
  assert.equal(satisfying("^(([a-z])\\2|zzz)$"), "zzz");
});

test("grupos, opcionales y anidamiento", () => {
  // Un grupo opcional se omite: el payload mínimo válido es el que más probablemente se acepte.
  assert.equal(satisfying("^(\\+34)?[0-9]{9}$"), "000000000");
  assert.equal(satisfying("^[A-Z]{2}(-[A-Z]{2})*$"), "AA");
  assert.equal(satisfying("^(?:usuario|admin)_[a-z]{2,4}$"), "usuario_aa");
});

test("minLength estira la repetición que puede crecer", () => {
  // `{2,8}` bajo minLength 6 da seis, no dos y un valor que el llamante tiene que tirar.
  assert.equal(satisfying("^[a-z]{2,8}$", 6), "aaaaaa");
  assert.equal(satisfying("^[a-z]+$", 4), "aaaa");
  // Y una longitud fija ignora la pista: las dos reglas no se pueden cumplir a la vez, y el
  // llamante lo descubre comparando.
  assert.equal(exampleFromPattern("^[a-z]{2}$", 6), "aa");
});

test("lo que no se implementa se abandona, no se aproxima", () => {
  // Un valor que parece cumplir una regla y no la cumple es peor que uno que visiblemente no la
  // cumple, porque el primero manda a alguien a mirar el endpoint.
  assert.equal(exampleFromPattern("^([a-z]+)\\1$"), undefined, "retrorreferencia");
  assert.equal(exampleFromPattern("^\\p{L}+$"), undefined, "propiedad Unicode");
  assert.equal(exampleFromPattern("^[a-z"), undefined, "clase sin cerrar");
  assert.equal(exampleFromPattern("^(abc$"), undefined, "grupo sin cerrar");
  assert.equal(exampleFromPattern("^a{3,2}$"), undefined, "un rango imposible");
  assert.equal(exampleFromPattern("^[a-z]+*$"), undefined, "cuantificador sin nada que repetir");
  assert.equal(exampleFromPattern(""), undefined);
  assert.equal(exampleFromPattern("a".repeat(500)), undefined, "más largo que cualquier patrón real");
});

test("un patrón que se puede satisfacer con lo que ya trae el formato usa ese valor", () => {
  // `2024-01-01` dice más que una cadena montada carácter a carácter.
  assert.equal(exampleFromSchema({ type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), "2024-01-01");
  // Y si no lo cumple, manda el patrón.
  assert.equal(exampleFromSchema({ type: "string", format: "date", pattern: "^[A-Z]{2}\\d{2}$" }), "AA00");
});

test("el patrón gana al marcador, y el marcador vuelve si el patrón no se puede cumplir", () => {
  assert.equal(exampleFromSchema({ type: "string", pattern: "^SKU-[0-9]{6}$" }), "SKU-000000");
  // Retrorreferencia: no se implementa, así que el marcador sigue. El 422 que llegue es la
  // verdad sobre un contrato que esto no sabe satisfacer, y apunta a la sección `bodies`.
  assert.equal(exampleFromSchema({ type: "string", pattern: "^([a-z])\\1$" }), "ejemplo");
  // Un patrón sintácticamente roto no puede tirar la generación del cuerpo entero.
  assert.equal(exampleFromSchema({ type: "string", pattern: "[" }), "ejemplo");
});

test("el patrón se respeta dentro de un objeto, con el resto de reglas del campo", () => {
  const body = exampleFromSchema({
    type: "object",
    required: ["referencia"],
    properties: { referencia: { type: "string", pattern: "^[A-Z]{2}-\\d{3}$", minLength: 6, maxLength: 6 } },
  });
  assert.deepEqual(body, { referencia: "AA-000" });
});

test("es determinista", () => {
  assert.equal(exampleFromPattern("^[a-z]{4}-\\d{2}$"), exampleFromPattern("^[a-z]{4}-\\d{2}$"));
});
