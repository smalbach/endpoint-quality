import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { payloadFor, serializeRequestBody } from "../src/request-body.ts";

/**
 * De la forma guardada a los bytes que salen.
 *
 * Es la conversión que el editor no puede enseñar y el destino sí nota. Cada una de las cinco
 * formas existe porque una API real pide exactamente eso —un login como formulario, un webhook
 * como el XML que manda su proveedor— y el fallo de cada una es el mismo: el destino contesta 400
 * y el informe enseña un cuerpo que parecía correcto.
 */
describe("el cuerpo de una petición, convertido en bytes", () => {
  test("«sin cuerpo» no es un cuerpo vacío: no se manda nada", () => {
    assert.equal(serializeRequestBody({ type: "none" }), null);
    assert.equal(serializeRequestBody(undefined), null);
  });

  test("un JSON sin claves sí es un cuerpo: alguien eligió mandarlo vacío", () => {
    assert.deepEqual(serializeRequestBody({ type: "json", json: {} }), {
      contentType: "application/json",
      text: "{}",
    });
  });

  test("el texto va tal cual, con el content-type que se escribió", () => {
    assert.deepEqual(serializeRequestBody({ type: "raw", text: "<pedido/>", contentType: "application/xml" }), {
      contentType: "application/xml",
      text: "<pedido/>",
    });
  });

  test("un formulario urlencoded codifica sus valores, que es todo el motivo de codificarlo aquí", () => {
    const serialized = serializeRequestBody({
      type: "x-www-form-urlencoded",
      // El espacio y el ampersand son los dos que parten el payload si el valor viaja sin escapar:
      // el destino leería tres campos donde se escribieron dos.
      fields: { nombre: "Ana Ruiz", nota: "a&b" },
      disabledFields: {},
    });
    assert.equal(serialized?.contentType, "application/x-www-form-urlencoded");
    assert.equal(serialized?.text, "nombre=Ana+Ruiz&nota=a%26b");
  });

  test("un campo apagado no se manda: vive en el otro mapa", () => {
    const serialized = serializeRequestBody({
      type: "x-www-form-urlencoded",
      fields: { nombre: "Ana" },
      disabledFields: { debug: "1" },
    });
    assert.equal(serialized?.text, "nombre=Ana");
  });

  test("el multipart lleva su frontera dentro del content-type, y la misma en el cuerpo", () => {
    const serialized = serializeRequestBody({
      type: "form-data",
      fields: { nombre: "Ana" },
      disabledFields: {},
    });
    const boundary = /boundary=(.+)$/.exec(serialized?.contentType ?? "")?.[1];
    assert.ok(boundary, `el content-type no declara frontera: ${serialized?.contentType}`);
    // Una frontera declarada en la cabecera y otra en el cuerpo es una petición que ningún destino
    // sabe leer, y el error que devuelve no habla de la frontera.
    assert.ok(serialized?.text.startsWith(`--${boundary}\r\n`));
    assert.ok(serialized?.text.endsWith(`--${boundary}--\r\n`));
    assert.ok(serialized?.text.includes('Content-Disposition: form-data; name="nombre"'));
    assert.ok(serialized?.text.includes("\r\n\r\nAna\r\n"));
  });

  test("un valor que contiene la frontera la ensancha en vez de corromper el cuerpo", () => {
    const serialized = serializeRequestBody({
      type: "form-data",
      fields: { pegado: "----EndpointQualityFormBoundary" },
      disabledFields: {},
    });
    const boundary = /boundary=(.+)$/.exec(serialized?.contentType ?? "")?.[1] ?? "";
    assert.notEqual(boundary, "----EndpointQualityFormBoundary");
    // Lo que hay que comprobar no es que sea distinta, sino que el valor ya no la contiene: si la
    // contuviera, el destino cortaría el campo por la mitad y leería basura como una parte más.
    assert.ok(!"----EndpointQualityFormBoundary".includes(boundary));
  });

  test("una comilla en el nombre de un campo se escapa en vez de cerrar el parámetro antes", () => {
    const serialized = serializeRequestBody({
      type: "form-data",
      fields: { 'a"b': "1" },
      disabledFields: {},
    });
    assert.ok(serialized?.text.includes('name="a\\"b"'));
  });

  test("la frontera es la misma dos veces: una corrida tiene que poder compararse con la de ayer", () => {
    const body = { type: "form-data", fields: { a: "1" }, disabledFields: {} } as const;
    assert.equal(serializeRequestBody(body)?.contentType, serializeRequestBody(body)?.contentType);
  });
});

/**
 * Cuál de los dos campos del paso lleva el cuerpo.
 *
 * `body` es el JSON —lo que genera la matriz y lo que la comprobación de persistencia compara
 * campo a campo—; `payload` es lo que describe una petición guardada cuando no es JSON. Nunca los
 * dos, y quien decide cuál es `scenarioFor`. Lo que se comprueba aquí es que el ejecutor no tiene
 * que saberlo: pide el cuerpo y le llega.
 */
describe("el cuerpo que un paso manda", () => {
  test("sin ninguno de los dos, no hay cuerpo", () => {
    assert.equal(payloadFor({}), null);
  });

  test("el JSON de la matriz se serializa como JSON", () => {
    assert.deepEqual(payloadFor({ body: { name: "x" } }), {
      contentType: "application/json",
      text: '{"name":"x"}',
    });
  });

  test("el cuerpo descrito por una petición guardada gana, porque es el que alguien escribió", () => {
    const payload = payloadFor({ payload: { type: "raw", text: "hola", contentType: "text/plain" } });
    assert.deepEqual(payload, { contentType: "text/plain", text: "hola" });
  });
});
