/**
 * Los operadores y las etiquetas que `checks.test.ts` no llega a tocar.
 *
 * Cada operador es aritmética, pero la aritmética también se equivoca: un `not_contains` que
 * devolviera lo mismo que `contains` pasaría cualquier suite que solo probara el positivo. Aquí va
 * cada negación contra su afirmación, y las etiquetas generadas que un informe enseña tal cual.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { evaluateChecks, type CheckMessage, type StepCheck } from "../src/checks.ts";
import type { ActualResponse } from "../src/assertions.ts";

const response = (over: Partial<ActualResponse> = {}): ActualResponse => ({
  status: 200,
  statusText: "OK",
  contentType: "application/json",
  headers: {},
  body: { tags: ["a", "b"], name: "widget", count: 5, meta: { x: 1 }, nothing: null },
  raw: "",
  ...over,
});
const one = (check: StepCheck, over: Partial<ActualResponse> = {}) =>
  evaluateChecks([check], { response: response(over), durationMs: 10 })[0];
const onMessages = (check: StepCheck, messages?: CheckMessage[]) =>
  evaluateChecks([check], { response: response(), durationMs: 10, ...(messages ? { messages } : {}) })[0];

describe("las negaciones", () => {
  test("not_equals es lo contrario de equals, también comparando como texto", () => {
    assert.equal(one({ source: "status", operator: "not_equals", value: 201 }).pass, true);
    assert.equal(one({ source: "status", operator: "not_equals", value: "200" }).pass, false);
  });

  test("not_contains mira los elementos de una lista y el texto de lo demás", () => {
    assert.equal(one({ source: "body", path: "tags", operator: "not_contains", value: "c" }).pass, true);
    assert.equal(one({ source: "body", path: "tags", operator: "not_contains", value: "a" }).pass, false);
    assert.equal(one({ source: "body", path: "name", operator: "not_contains", value: "zzz" }).pass, true);
    assert.equal(one({ source: "body", path: "name", operator: "not_contains", value: "idg" }).pass, false);
  });

  test("greater_than compara como número", () => {
    assert.equal(one({ source: "body", path: "count", operator: "greater_than", value: "4" }).pass, true);
    assert.equal(one({ source: "body", path: "count", operator: "greater_than", value: 5 }).pass, false);
  });
});

describe("contains sobre valores que no son texto", () => {
  test("un objeto se busca en su JSON y lo ausente es texto vacío", () => {
    assert.equal(one({ source: "body", path: "meta", operator: "contains", value: '"x":1' }).pass, true);
    assert.equal(one({ source: "body", path: "nothing", operator: "contains", value: "a" }).pass, false);
    assert.equal(one({ source: "body", path: "nothing", operator: "contains", value: null }).pass, true);
  });
});

describe("tamaños", () => {
  test("un objeto mide sus claves, un escalar mide uno y lo ausente cero", () => {
    assert.equal(one({ source: "body", path: "meta", operator: "has_length", value: 1 }).pass, true);
    assert.equal(one({ source: "body", path: "count", operator: "has_length", value: 1 }).pass, true);
    assert.equal(one({ source: "body", path: "nothing", operator: "is_not_empty" }).pass, false);
    assert.equal(one({ source: "body", path: "missing", operator: "is_not_empty" }).pass, false);
    assert.equal(one({ source: "body", path: "tags", operator: "has_length", value: 2 }).pass, true);
  });
});

describe("lo que se escribe en el informe", () => {
  test("un null se dice null y un valor largo se corta", () => {
    assert.equal(one({ source: "body", path: "nothing", operator: "exists" }).detail, "Obtenido null");
    const long = "x".repeat(250);
    const detail = one({ source: "body", path: "name", operator: "equals", value: "widget" }, {
      body: { name: long },
    }).detail;
    assert.equal(detail, `Obtenido ${"x".repeat(200)}…`);
  });

  test("una cabecera sin nombre no apunta a nada y su etiqueta no deja espacios colgando", () => {
    const assertion = one({ source: "header", operator: "exists" });
    assert.equal(assertion.label, "cabecera existe");
    assert.equal(assertion.pass, false);
  });

  test("el body sin ruta es el cuerpo entero", () => {
    const assertion = one({ source: "body", operator: "is_not_empty" });
    assert.equal(assertion.label, "body no está vacío");
    assert.equal(assertion.pass, true);
  });
});

describe("mensajes filtrados y combinados", () => {
  test("un filtro de tema sin mensajes recibidos cuenta cero", () => {
    const assertion = onMessages({ source: "messageCount", operator: "equals", value: 0, match: { at: "last", topic: "a/#" } });
    assert.equal(assertion.pass, true);
    assert.equal(assertion.detail, "Obtenido 0");
  });

  test("any con severidad la conserva, pase o no llegue nada", () => {
    const check: StepCheck = {
      source: "message",
      path: "ok",
      operator: "equals",
      value: true,
      severity: "warning",
      match: { at: "any" },
    };
    assert.equal(onMessages(check, []).severity, "warning");
    const passed = onMessages(check, [{ seq: 1, body: '{"ok":true}' }]);
    assert.equal(passed.pass, true);
    assert.equal(passed.severity, "warning");
  });

  test("una expresión mal escrita en all se informa en vez de tumbar la corrida", () => {
    const assertion = onMessages({ source: "message", operator: "matches", value: "(", match: { at: "all" } }, [
      { seq: 1, body: "hola" },
    ]);
    assert.equal(assertion.pass, false);
    assert.match(assertion.detail, /Invalid regular expression/);
  });

  test("si lo que se lanza no es un Error, el detalle lo dice sin inventar un mensaje", () => {
    // El valor viene de JSON en la práctica, pero el motor acepta `unknown` y no puede suponerlo.
    const hostile = {
      toString() {
        throw "no";
      },
    };
    const across = onMessages({ source: "message", operator: "matches", value: hostile, match: { at: "any" } }, [
      { seq: 1, body: "hola" },
    ]);
    assert.equal(across.detail, "La comprobación no se pudo evaluar");
    const single = one({ source: "status", operator: "matches", value: hostile });
    assert.equal(single.detail, "La comprobación no se pudo evaluar");
    assert.equal(single.pass, false);
  });
});
