/**
 * The verdict of a single response, and the one invariant it must never break.
 *
 * **A red case always names its reason.** That is the product's entire claim turned on itself: the
 * thing it replaces is a suite whose green ticks assert nothing, and a red row whose assertions
 * are all green is the same failure from the other side — a verdict nobody can act on.
 *
 * It broke exactly once, and quietly. `ok` was written as a parallel boolean expression that
 * happened to agree with the assertion list most of the time, and one of its terms — the envelope
 * check — had no assertion at all when the contract declared a schema. `/health` is where anybody
 * would meet it: the response satisfies the declared schema and is not the project's list
 * envelope, so the case failed with four green assertions and no explanation available short of
 * reading the engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateResponse, type ActualResponse } from "../src/assertions.ts";
import type { Assertion } from "../src/types.ts";

const response = (over: Partial<ActualResponse> = {}): ActualResponse => ({
  status: 200,
  statusText: "OK",
  contentType: "application/json",
  headers: {},
  body: { data: [] },
  raw: '{"data":[]}',
  ...over,
});

const evaluate = (over: Parameters<typeof evaluateResponse>[0] extends infer T ? Partial<T> : never = {}) =>
  evaluateResponse({
    method: "GET",
    operationPath: "/things",
    expectedStatus: 200,
    expectedShape: "{ data }",
    errorShape: "ProblemDetails",
    schema: null,
    budget: null,
    latencySamples: [5],
    actual: response(),
    ...over,
  });

const failed = (assertions: Assertion[]) => assertions.filter((assertion) => !assertion.pass);

test("un caso en rojo siempre trae al menos una aserción en rojo", () => {
  // The invariant, stated over the cases that used to break it: a declared schema that the
  // response satisfies, and an envelope the project did not expect.
  const healthSchema = {
    type: "object",
    required: ["status", "checks"],
    properties: { status: { type: "string" }, checks: { type: "object" } },
  };
  const evaluation = evaluate({
    schema: healthSchema,
    expectedShape: "{ data }",
    actual: response({ body: { status: "ok", checks: {} }, raw: '{"status":"ok","checks":{}}' }),
  });

  assert.equal(evaluation.ok, false, "la respuesta no tiene la forma que el proyecto espera");
  assert.ok(failed(evaluation.assertions).length > 0, "un rojo sin aserción en rojo no se puede accionar");
  assert.deepEqual(
    failed(evaluation.assertions).map((assertion) => assertion.label),
    ["Envelope { data }"],
  );
  // And the message says where the knob is, because the likelier fault is the project's rule.
  assert.match(failed(evaluation.assertions)[0].detail, /sección envelope/);
});

test("y un caso en verde no trae ninguna", () => {
  const evaluation = evaluate({
    schema: { type: "object", required: ["data"], properties: { data: { type: "array" } } },
  });
  assert.equal(evaluation.ok, true);
  assert.deepEqual(failed(evaluation.assertions), []);
});

test("sin schema declarado no se duplica la comprobación de envelope", () => {
  // `Schema OpenAPI` *is* the envelope check when the contract declares nothing for that status,
  // and its own detail says so. A second assertion repeating it would be noise.
  const evaluation = evaluate({ schema: null, actual: response({ body: { items: [] }, raw: '{"items":[]}' }) });
  assert.equal(evaluation.ok, false);
  assert.deepEqual(
    evaluation.assertions.map((assertion) => assertion.label),
    ["Status 200", "Schema OpenAPI", "Content-Type"],
  );
  assert.deepEqual(
    failed(evaluation.assertions).map((assertion) => assertion.label),
    ["Schema OpenAPI"],
  );
});

test("un 405 silencia el resto y dice por qué", () => {
  // The diagnosis that matters is that the operation has no router. Reporting the envelope of a
  // response the API never produced buries the only actionable line.
  const evaluation = evaluate({ actual: response({ status: 405, body: "", raw: "", contentType: "text/plain" }) });
  assert.equal(evaluation.notImplemented, true);
  assert.equal(evaluation.ok, false);
  assert.ok(failed(evaluation.assertions).length > 0);
  assert.match(evaluation.assertions[0].detail, /no está implementado/);
});
