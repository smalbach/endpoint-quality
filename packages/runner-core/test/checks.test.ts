/**
 * Las comprobaciones que escribe una persona, no las que se derivan del contrato.
 *
 * Lo que se prueba aquí no es la tabla de operadores —eso es aritmética— sino las dos decisiones
 * que hacen que la tabla sirva: que una comprobación deja constancia aunque pase, y que comparar
 * «200» con 200 es la misma afirmación. La primera es lo que separa un informe de un tic verde; la
 * segunda es lo que separa un formulario usable de un acertijo sobre el tipo de un campo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateChecks, type StepCheck } from "../src/checks.ts";
import type { ActualResponse } from "../src/assertions.ts";
import { holds } from "../src/types.ts";

const response = (over: Partial<ActualResponse> = {}): ActualResponse => ({
  status: 200,
  statusText: "OK",
  contentType: "application/json",
  headers: { "x-total-count": "3" },
  body: { data: [{ id: 1 }, { id: 2 }, { id: 3 }], total: 3, page: { size: 20 } },
  raw: "",
  ...over,
});
const run = (checks: StepCheck[], durationMs = 42) => evaluateChecks(checks, { response: response(), durationMs });

test("una comprobación que pasa también sale en el informe", () => {
  const [assertion] = run([{ source: "status", operator: "equals", value: 200 }]);
  assert.equal(assertion.pass, true);
  // Sin esto no hay forma de saber que la comprobación llegó a ejecutarse, que es justo lo que
  // convierte una suite verde en una suite que no afirma nada.
  assert.equal(assertion.label, "status es 200");
  assert.equal(assertion.detail, "Obtenido 200");
});

test("el status se compara como texto: «200» y 200 son la misma afirmación", () => {
  assert.equal(run([{ source: "status", operator: "equals", value: "200" }])[0].pass, true);
  assert.equal(run([{ source: "status", operator: "equals", value: 201 }])[0].pass, false);
});

test("una ruta con puntos entra en el cuerpo, y un índice también", () => {
  assert.equal(run([{ source: "body", path: "page.size", operator: "equals", value: 20 }])[0].pass, true);
  assert.equal(run([{ source: "body", path: "data.0.id", operator: "equals", value: 1 }])[0].pass, true);
  assert.equal(run([{ source: "body", path: "data.9.id", operator: "not_exists" }])[0].pass, true);
});

test("una lista se juzga como lista y no como su texto", () => {
  assert.equal(run([{ source: "body", path: "data", operator: "is_array" }])[0].pass, true);
  assert.equal(run([{ source: "body", path: "data", operator: "has_length", value: 3 }])[0].pass, true);
  assert.equal(run([{ source: "body", path: "data", operator: "is_not_empty" }])[0].pass, true);
  assert.equal(run([{ source: "body", path: "data", operator: "contains", value: { id: 2 } }])[0].pass, true);
});

test("una cabecera se encuentra escrita como sea, porque su nombre no distingue mayúsculas", () => {
  assert.equal(run([{ source: "header", path: "X-Total-Count", operator: "equals", value: 3 }])[0].pass, true);
});

test("la duración es una comprobación como otra cualquiera", () => {
  assert.equal(run([{ source: "durationMs", operator: "less_than", value: 300 }])[0].pass, true);
  assert.equal(run([{ source: "durationMs", operator: "less_than", value: 10 }])[0].pass, false);
});

test("una expresión regular rota se cuenta como fallo de la comprobación, no como caída de la corrida", () => {
  const [assertion] = run([{ source: "body", path: "total", operator: "matches", value: "(" }]);
  assert.equal(assertion.pass, false);
  assert.match(assertion.detail, /Invalid regular expression|no se pudo evaluar/);
});

test("un aviso queda registrado y no tumba el caso", () => {
  const assertions = run([
    { source: "status", operator: "equals", value: 200 },
    { source: "body", path: "total", operator: "equals", value: 99, severity: "warning" },
  ]);
  assert.equal(assertions[1].pass, false);
  assert.equal(assertions[1].severity, "warning");
  assert.equal(holds(assertions), true);
});

test("un fallo sin severidad sí tumba el caso", () => {
  assert.equal(holds(run([{ source: "body", path: "total", operator: "equals", value: 99 }])), false);
});

test("una etiqueta escrita a mano gana a la generada", () => {
  const [assertion] = run([{ label: "hay tres cosas", source: "body", path: "total", operator: "equals", value: 3 }]);
  assert.equal(assertion.label, "hay tres cosas");
});
