/**
 * Lo capturado: tapado al escribir, y convertido en HAR para entrar por el import de siempre.
 *
 * La segunda mitad es la que fija que no hay un segundo lector: lo que sale de `captureToHar` pasa
 * por `parseEndpointFile("har", …)`, con su filtro de ruido y su deduplicación por ruta.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  captureItemFrom,
  captureToFlowCollection,
  captureToHar,
  redactCapturedBody,
  redactCapturedHeaders,
  redactCapturedUrl,
  viewCaptureItemSummary,
  type RawExchange,
} from "@/modules/captures/domain/model";
import { MASK } from "@/modules/endpoints/domain/examples";
import { parseEndpointFile } from "@/modules/endpoints/domain/import-endpoints";

let seq = 0;
function exchange(patch: Partial<RawExchange> & { url: string }): ReturnType<typeof captureItemFrom> {
  seq += 1;
  const raw: RawExchange = {
    at: new Date("2026-03-01T10:00:00Z"),
    method: "GET",
    status: 200,
    encrypted: false,
    requestHeaders: {},
    requestBody: Buffer.alloc(0),
    requestBodyTruncated: false,
    responseHeaders: { "content-type": "application/json" },
    responseBody: Buffer.from("{}"),
    responseBodyTruncated: false,
    durationMs: 3,
    error: null,
    ...patch,
  };
  return captureItemFrom(raw, { sessionId: "s", projectId: "p", seq });
}

describe("la redacción al grabar", () => {
  test("la Authorization conserva el esquema y pierde el valor; la cookie y las claves se tapan", () => {
    assert.deepEqual(
      redactCapturedHeaders({
        Authorization: "Bearer abc.def",
        cookie: "sid=1",
        "X-Api-Key": "k",
        Accept: "application/json",
      }),
      { Authorization: "Bearer ••••••••", cookie: "••••••••", "X-Api-Key": "••••••••", Accept: "application/json" },
    );
  });

  test("la query con nombre de credencial se tapa sin tocar el resto", () => {
    assert.equal(
      redactCapturedUrl("https://api.test/x?page=2&access_token=SECRETO&q=a%20b#frag"),
      "https://api.test/x?page=2&access_token=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2&q=a%20b",
    );
  });

  test("un formulario y un JSON pierden el valor de la contraseña", () => {
    assert.ok(!redactCapturedBody("user=a&password=hunter2", "application/x-www-form-urlencoded").includes("hunter2"));
    assert.ok(!redactCapturedBody('{"password":"hunter2"}', "application/json").includes("hunter2"));
  });

  test("un cuerpo cortado por el tope tampoco guarda la credencial", () => {
    const item = exchange({
      url: "https://api.test/login",
      responseBody: Buffer.from('{"access_token":"SECRETO-CORTADO","lista":[1,2'),
      responseBodyTruncated: true,
    });
    assert.ok(!item.responseBody.includes("SECRETO-CORTADO"));
  });

  test("un secreto que el servidor repite en otro campo se tapa por su valor, como el eco de httpbin", () => {
    const item = exchange({
      url: "http://httpbin.org/get?api_key=CLAVE-eco-88&q=1",
      requestHeaders: {
        Authorization: "Bearer SECRETO-eco-77",
        Cookie: "sid=galleta-eco-66; tema=claro",
      },
      responseHeaders: {
        "content-type": "application/json",
        "set-cookie": "nueva=galleta-eco-55; Domain=httpbin.org; Path=/",
      },
      responseBody: Buffer.from(
        JSON.stringify({
          url: "http://httpbin.org/get?api_key=CLAVE-eco-88&q=1",
          headers: { "X-Echo": "Bearer SECRETO-eco-77", Otra: "sid=galleta-eco-66" },
          nota: "vuelve galleta-eco-55",
        }),
      ),
    });
    const stored = JSON.stringify(item);
    for (const secret of ["CLAVE-eco-88", "SECRETO-eco-77", "galleta-eco-66", "galleta-eco-55"])
      assert.equal(stored.includes(secret), false, secret);
    // Lo que no es credencial se queda: el dominio de la cookie no es un secreto.
    assert.ok(stored.includes("httpbin.org"));
    assert.ok(item.url.endsWith("&q=1"));
    assert.equal(JSON.parse(item.responseBody).url, `http://httpbin.org/get?api_key=${MASK}&q=1`);
  });

  test("un cuerpo que no es texto no se guarda", () => {
    const item = exchange({
      url: "https://api.test/img",
      responseBody: Buffer.from([0x89, 0x50, 0x00, 0xff, 0xfe, 0x00]),
    });
    assert.equal(item.responseBody, "");
  });

  test("un túnel se enseña como cifrado, y el ruido con el motivo del filtro del HAR", () => {
    const tunnel = exchange({ url: "https://api.test:443", method: "CONNECT", encrypted: true, status: null });
    assert.equal(viewCaptureItemSummary(tunnel).noise, "cifrado, sin detalle");
    const bundle = exchange({
      url: "https://app.test/main.js",
      responseHeaders: { "content-type": "text/javascript" },
    });
    assert.match(viewCaptureItemSummary(bundle).noise ?? "", /recursos de la página/);
    assert.equal(viewCaptureItemSummary(exchange({ url: "https://api.test/pedidos" })).noise, null);
  });
});

describe("de la captura al import, por el camino del HAR", () => {
  test("el filtro de ruido, la ruta repetida como ejemplo y la credencial sin valor", () => {
    const items = [
      exchange({
        url: "https://api.test/pedidos?page=1",
        requestHeaders: { Authorization: "Bearer TOKEN" },
        responseBody: Buffer.from('{"items":[]}'),
      }),
      exchange({ url: "https://api.test/pedidos?page=2", status: 404, responseBody: Buffer.from('{"error":"x"}') }),
      exchange({ url: "https://app.test/main.js", responseHeaders: { "content-type": "text/javascript" } }),
      exchange({ url: "https://api.test/pedidos", method: "OPTIONS", status: 204, responseHeaders: {} }),
      exchange({ url: "https://api.test:443", method: "CONNECT", encrypted: true, status: null }),
      exchange({
        url: "https://api.test/pedidos",
        method: "POST",
        status: 201,
        requestHeaders: { "Content-Type": "application/json" },
        requestBody: Buffer.from('{"producto":7}'),
      }),
    ];
    const parsed = parseEndpointFile("har", captureToHar(items));
    assert.deepEqual(
      parsed.drafts.map((draft) => `${draft.method} ${draft.path}`),
      ["GET /pedidos", "POST /pedidos"],
    );
    const [list, create] = parsed.drafts;
    assert.deepEqual(
      list.examples?.map((example) => example.status),
      [200, 404],
    );
    assert.equal(list.auth?.type, "bearer");
    assert.equal(JSON.stringify(parsed).includes('TOKEN"'), false);
    assert.equal(create.body?.mode, "json");
    assert.ok(parsed.skipped.some((entry) => /recursos de la página/.test(entry.reason)));
    assert.ok(parsed.skipped.some((entry) => /OPTIONS/.test(entry.reason)));
  });

  test("el flujo lleva las peticiones de la API en orden, repetidas incluidas", () => {
    const items = [
      exchange({ url: "https://api.test/login", method: "POST", status: 200 }),
      exchange({ url: "https://app.test/main.js", responseHeaders: { "content-type": "text/javascript" } }),
      exchange({ url: "https://api.test/pedidos" }),
      exchange({ url: "https://api.test/pedidos" }),
    ];
    const flow = captureToFlowCollection("Captura", items);
    assert.equal(flow.steps, 3);
    const collection = JSON.parse(flow.text);
    assert.deepEqual(
      collection.item.map((entry: { name: string }) => entry.name),
      ["POST /login", "GET /pedidos", "GET /pedidos"],
    );
  });
});
