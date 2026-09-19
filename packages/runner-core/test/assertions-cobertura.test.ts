/**
 * Los veredictos de `assertions.ts` en los bordes que el resto de la suite no pisa: la deriva de un
 * documento, las formas sin clave, el diagnóstico de un schema que no se pudo leer y los ids que no
 * vienen donde se esperan.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { capturedId, envelopeKey, evaluateResponse, matchesShape, type ActualResponse } from "../src/assertions.ts";
import type { Assertion } from "../src/types.ts";

const response = (over: Partial<ActualResponse> = {}): ActualResponse => ({
  status: 200,
  statusText: "OK",
  contentType: "application/json",
  headers: {},
  body: { data: { id: 1 } },
  raw: "{}",
  ...over,
});
const base = {
  method: "GET",
  operationPath: "/things/{id}",
  expectedStatus: 200,
  expectedShape: "{ data: Resource }",
  errorShape: "ProblemDetails",
  schema: null,
  budget: null,
  latencySamples: [5],
};
const find = (label: string, assertions: Assertion[]) => assertions.find((item) => item.label === label);

describe("el detalle del status", () => {
  test("sin texto de estado el detalle es solo el código", () => {
    const verdict = evaluateResponse({ ...base, actual: response({ statusText: "" }) });
    assert.equal(verdict.assertions[0].detail, "Recibido 200");
  });
});

describe("campos no declarados", () => {
  const schema = { type: "object", properties: { data: { type: "object", properties: { id: { type: "integer" } } } } };

  test("un cuerpo válido con campos de más avisa sin tumbar el caso", () => {
    const verdict = evaluateResponse({
      ...base,
      schema,
      actual: response({ body: { data: { id: 1, extra: true } } }),
    });
    const drift = find("Campos no declarados", verdict.assertions)!;
    assert.equal(drift.pass, false);
    assert.equal(drift.severity, "warning");
    assert.equal(drift.detail, "La respuesta trae 1 campo(s) que el contrato no declara: $.data.extra");
    // Un aviso no es un fallo: el endpoint cumple, es su documento el que se quedó atrás.
    assert.equal(verdict.ok, true);
  });

  test("con más de cinco se enseñan cinco y se dice que hay más", () => {
    const body = { data: { id: 1, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 } };
    const verdict = evaluateResponse({ ...base, schema, actual: response({ body }) });
    const drift = find("Campos no declarados", verdict.assertions)!;
    assert.match(drift.detail, /^La respuesta trae 6 campo\(s\).*\$\.data\.e…$/);
  });

  test("sin campos de más no hay aviso", () => {
    const verdict = evaluateResponse({ ...base, schema, actual: response() });
    assert.equal(find("Campos no declarados", verdict.assertions), undefined);
  });
});

describe("el diagnóstico del schema", () => {
  test("si el schema no se pudo leer, el detalle lo explica y dice qué se verificó en su lugar", () => {
    const verdict = evaluateResponse({ ...base, schemaDiagnostic: "El documento no se pudo descargar", actual: response() });
    assert.equal(
      find("Schema OpenAPI", verdict.assertions)!.detail,
      "El documento no se pudo descargar. Se verificó el envelope { data: Resource }",
    );
  });
});

describe("formas del envelope", () => {
  test("HealthStatus pide status y checks", () => {
    assert.equal(matchesShape(response({ body: { status: "ok", checks: {} } }), "HealthStatus", "ProblemDetails"), true);
    assert.equal(matchesShape(response({ body: { status: "ok" } }), "HealthStatus", "ProblemDetails"), false);
  });

  test("una forma que no nombra clave acepta cualquier objeto", () => {
    assert.equal(envelopeKey("Resource"), null);
    assert.equal(matchesShape(response({ body: { cualquier: 1 } }), "Resource", "ProblemDetails"), true);
    assert.equal(matchesShape(response({ body: [1] }), "Resource", "ProblemDetails"), false);
  });
});

describe("el id capturado", () => {
  test("un cuerpo que no es objeto no tiene id", () => {
    assert.equal(capturedId("texto", "{ data: Resource }", "id"), undefined);
    assert.equal(capturedId(null, "Resource", "id"), undefined);
  });

  test("con una forma sin clave el id se lee del cuerpo entero", () => {
    assert.equal(capturedId({ id: 7 }, "Resource", "id"), "7");
  });
});
