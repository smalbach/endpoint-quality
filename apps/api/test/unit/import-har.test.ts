/**
 * Leer un HAR, que es lo que graba la pestaña de red de cualquier navegador.
 *
 * Lo que se comprueba aquí es sobre todo **lo que se tira**. Un HAR de una pestaña son doscientas
 * entradas y unas ocho son la API; si el filtro no funciona, el import mete doscientos endpoints y
 * los que importan no se encuentran — que es peor que no importar, porque hay que borrar ciento
 * noventa a mano.
 *
 * Y el riesgo simétrico, el que nadie prueba: **tirar de más.** Un `application/problem+json` es una
 * respuesta de error de una API de verdad, y un endpoint que devuelve `text/plain` existe. Si el
 * filtro se los come, el import se queda corto y en silencio.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { harNoise, parseHar } from "@/modules/workflows/domain/import-requests";

type Entry = Record<string, unknown>;

const entry = (patch: {
  method?: string;
  url?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  body?: string;
  encoding?: string;
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
  postData?: Record<string, unknown>;
}): Entry => ({
  request: {
    method: patch.method ?? "GET",
    url: patch.url ?? "https://api.tienda.test/v1/pedidos",
    headers: patch.requestHeaders ?? [{ name: "Accept", value: "application/json" }],
    ...(patch.postData ? { postData: patch.postData } : {}),
  },
  response: {
    status: patch.status ?? 200,
    ...(patch.statusText ? { statusText: patch.statusText } : {}),
    headers: patch.responseHeaders ?? [{ name: "Content-Type", value: "application/json" }],
    content: {
      mimeType: patch.mimeType ?? "application/json",
      text: patch.body ?? '{"items":[]}',
      ...(patch.encoding ? { encoding: patch.encoding } : {}),
    },
  },
  time: 42,
});

const har = (entries: Entry[]) => JSON.stringify({ log: { version: "1.2", entries } });

describe("lo que no es la API", () => {
  it("el HTML, el JavaScript, el CSS, las fuentes y las imágenes se quedan fuera", () => {
    const noise = [
      "text/html",
      "text/css",
      "application/javascript",
      "text/javascript",
      "image/png",
      "image/svg+xml",
      "font/woff2",
      "application/font-woff",
      "video/mp4",
      "application/wasm",
    ];
    for (const mimeType of noise) {
      assert.ok(harNoise("GET", "https://api.tienda.test/x", mimeType), mimeType);
    }
  });

  it("el OPTIONS de preflight, que lo manda el navegador y no la aplicación", () => {
    assert.match(harNoise("OPTIONS", "https://api.tienda.test/v1/pedidos", "") ?? "", /preflight/);
  });

  it("la telemetría, que no es la API que se está probando", () => {
    const hosts = [
      "https://www.google-analytics.com/collect",
      "https://o123.ingest.sentry.io/api/1/envelope",
      "https://api.segment.io/v1/t",
      "https://cdn.mxpnl.com/x",
    ];
    // `cdn.mxpnl.com` no está en la lista: la lista son dominios, no marcas, y decirlo importa.
    assert.match(harNoise("POST", hosts[0]!, "application/json") ?? "", /telemetría/);
    assert.match(harNoise("POST", hosts[1]!, "application/json") ?? "", /telemetría/);
    assert.match(harNoise("POST", hosts[2]!, "application/json") ?? "", /telemetría/);
  });

  it("un dominio que solo acaba pareciéndose no cuenta como telemetría", () => {
    // `no-sentry.io` y `misentry.io` no son `sentry.io`: la comprobación exige el punto o el
    // principio de la cadena, que es la misma regla que las cookies de la RFC 6265.
    assert.equal(harNoise("POST", "https://misentry.io/x", "application/json"), null);
    assert.equal(harNoise("POST", "https://sentry.io.miapi.test/x", "application/json"), null);
  });

  it("lo que no va por http tampoco", () => {
    assert.match(harNoise("GET", "data:application/json,%7B%7D", "application/json") ?? "", /no van por http/);
  });
});

describe("lo que sí es la API, y no se puede tirar", () => {
  it("un application/problem+json es la respuesta de error de una API de verdad", () => {
    assert.equal(harNoise("GET", "https://api.tienda.test/v1/pedidos", "application/problem+json"), null);
  });

  it("un text/plain y un XML también son respuestas de API", () => {
    assert.equal(harNoise("GET", "https://api.tienda.test/v1/version", "text/plain"), null);
    assert.equal(harNoise("POST", "https://api.tienda.test/soap", "application/xml"), null);
  });

  it("una respuesta sin tipo no se tira: un 204 no lleva ninguno", () => {
    assert.equal(harNoise("DELETE", "https://api.tienda.test/v1/pedidos/7", ""), null);
  });

  it("una URL que no se puede partir se conserva: el emparejador solo lee la ruta", () => {
    assert.equal(harNoise("GET", "{{baseUrl}}/v1/pedidos", "application/json"), null);
  });
});

describe("una sesión de navegador entera", () => {
  const sesion = har([
    entry({ url: "https://tienda.test/", mimeType: "text/html" }),
    entry({ url: "https://tienda.test/assets/app.js", mimeType: "application/javascript" }),
    entry({ url: "https://tienda.test/assets/app.css", mimeType: "text/css" }),
    entry({ url: "https://tienda.test/logo.png", mimeType: "image/png" }),
    entry({ method: "OPTIONS", url: "https://api.tienda.test/v1/pedidos", mimeType: "" }),
    entry({ url: "https://www.google-analytics.com/collect", mimeType: "application/json" }),
    entry({ url: "https://api.tienda.test/v1/pedidos", status: 200, statusText: "OK" }),
    entry({
      url: "https://api.tienda.test/v1/pedidos/7",
      status: 404,
      statusText: "Not Found",
      body: '{"error":"no"}',
    }),
  ]);

  it("de ocho entradas salen dos endpoints, y los seis descartes se cuentan con su motivo", () => {
    const read = parseHar(sesion);
    assert.deepEqual(
      read.requests.map((request) => request.name),
      ["GET /v1/pedidos", "GET /v1/pedidos/7"],
    );
    // Agrupados por motivo y no uno por línea: 180 líneas iguales no informan más que una.
    const total = read.skipped.reduce((sum, entry) => sum + (Number(/^(\d+)/.exec(entry.reason)?.[1]) || 0), 0);
    assert.equal(total, 6);
    assert.ok(read.skipped.some((entry) => /preflight/.test(entry.reason)));
    assert.ok(read.skipped.some((entry) => /telemetría/.test(entry.reason)));
    assert.ok(read.skipped.some((entry) => /recursos de la página/.test(entry.reason)));
  });

  it("cada endpoint se trae la respuesta como ejemplo, con su código y su texto", () => {
    const read = parseHar(sesion);
    const [pedidos, uno] = read.requests;
    assert.equal(pedidos!.examples.length, 1);
    assert.equal(pedidos!.examples[0]!.name, "200 OK");
    assert.equal(pedidos!.examples[0]!.status, 200);
    assert.equal(pedidos!.examples[0]!.contentType, "application/json");
    assert.equal(uno!.examples[0]!.name, "404 Not Found");
    assert.equal(uno!.examples[0]!.body, '{"error":"no"}');
  });
});

describe("la misma ruta veinte veces", () => {
  it("es un endpoint con varios ejemplos, no veinte endpoints", () => {
    // Es lo que pasa en cualquier sesión real, y es lo que hace que un HAR valga la pena: un 200,
    // un 404 y un 422 de la misma ruta es la colección de ejemplos que a mano nadie escribe.
    const read = parseHar(
      har([
        entry({ status: 200, statusText: "OK" }),
        entry({ status: 404, statusText: "Not Found" }),
        entry({ status: 422, statusText: "Unprocessable Entity" }),
      ]),
    );
    assert.equal(read.requests.length, 1);
    assert.deepEqual(
      read.requests[0]!.examples.map((example) => example.status),
      [200, 404, 422],
    );
  });

  it("y la misma ruta con otro método son dos endpoints", () => {
    const read = parseHar(har([entry({ method: "GET" }), entry({ method: "POST" })]));
    assert.equal(read.requests.length, 2);
  });

  it("la cadena de consulta no separa dos endpoints: la ruta es la misma", () => {
    const read = parseHar(
      har([
        entry({ url: "https://api.tienda.test/v1/pedidos?page=1" }),
        entry({ url: "https://api.tienda.test/v1/pedidos?page=2" }),
      ]),
    );
    assert.equal(read.requests.length, 1);
    assert.equal(read.requests[0]!.examples.length, 2);
  });
});

describe("la autenticación que el navegador grabó", () => {
  it("el tipo sí, el token no", () => {
    // El tipo es lo que hace falta para volver a mandarla y no es un secreto. El valor es el token
    // de alguien, y este lector no guarda ninguno literal.
    const read = parseHar(
      har([entry({ requestHeaders: [{ name: "Authorization", value: "Bearer eyJhbGciOi.MUY.SECRETO" }] })]),
    );
    assert.deepEqual(read.requests[0]!.auth, { type: "bearer", params: { token: "" } });
    assert.ok(!JSON.stringify(read.requests[0]!.auth).includes("SECRETO"));
  });

  it("Basic y Digest se reconocen por su esquema", () => {
    const basic = parseHar(har([entry({ requestHeaders: [{ name: "authorization", value: "Basic YWJj" }] })]));
    assert.equal(basic.requests[0]!.auth.type, "basic");
    const digest = parseHar(
      har([entry({ requestHeaders: [{ name: "Authorization", value: 'Digest username="ana"' }] })]),
    );
    assert.equal(digest.requests[0]!.auth.type, "digest");
  });

  it("un esquema que no se conoce se queda en heredado, en vez de inventar un tipo", () => {
    const read = parseHar(har([entry({ requestHeaders: [{ name: "Authorization", value: "Negotiate abc" }] })]));
    assert.equal(read.requests[0]!.auth.type, "inherit");
  });

  it("sin cabecera de autenticación, heredado", () => {
    assert.equal(parseHar(har([entry({})])).requests[0]!.auth.type, "inherit");
  });
});

describe("el cuerpo y las cabeceras", () => {
  it("un cuerpo JSON entra como tal", () => {
    const read = parseHar(
      har([
        entry({
          method: "POST",
          postData: { mimeType: "application/json", text: '{"total":10}' },
        }),
      ]),
    );
    assert.equal(read.requests[0]!.body.type, "json");
  });

  it("un formulario entra por sus params, que es como el navegador lo graba", () => {
    const read = parseHar(
      har([
        entry({
          method: "POST",
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            params: [
              { name: "usuario", value: "ana" },
              { name: "recordar", value: "1" },
            ],
          },
        }),
      ]),
    );
    const body = read.requests[0]!.body;
    assert.equal(body.type, "x-www-form-urlencoded");
    assert.deepEqual("fields" in body ? body.fields : {}, { usuario: "ana", recordar: "1" });
  });

  it("un multipart se reconoce por su tipo y no se confunde con un formulario", () => {
    const read = parseHar(
      har([
        entry({
          method: "POST",
          postData: { mimeType: "multipart/form-data; boundary=x", params: [{ name: "fichero", value: "a.pdf" }] },
        }),
      ]),
    );
    assert.equal(read.requests[0]!.body.type, "form-data");
  });

  it("las pseudo-cabeceras de HTTP/2 no salen: mandarlas a mano da un 400", () => {
    const read = parseHar(
      har([
        entry({
          requestHeaders: [
            { name: ":method", value: "GET" },
            { name: ":path", value: "/v1/pedidos" },
            { name: ":authority", value: "api.tienda.test" },
            { name: "X-Trace", value: "abc" },
          ],
        }),
      ]),
    );
    assert.deepEqual(read.requests[0]!.headers, { "X-Trace": "abc" });
  });

  it("un cuerpo de respuesta en base64 se decodifica", () => {
    const read = parseHar(har([entry({ body: Buffer.from('{"id":7}').toString("base64"), encoding: "base64" })]));
    assert.equal(read.requests[0]!.examples[0]!.body, '{"id":7}');
  });
});

describe("lo que no se puede leer", () => {
  it("una entrada sin código de estado no da un ejemplo: el HAR anota cero cuando se canceló", () => {
    // Un ejemplo que dijera «0» —o que se inventara un 200— sería una afirmación falsa sobre la
    // API, y es justo lo que alguien va a leer como contrato.
    const read = parseHar(har([entry({ status: 0 })]));
    assert.equal(read.requests.length, 1);
    assert.deepEqual(read.requests[0]!.examples, []);
  });

  it("una entrada sin URL se nombra como saltada, no se ignora", () => {
    const read = parseHar(JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "" } }] } }));
    assert.equal(read.requests.length, 0);
    assert.match(read.skipped[0]!.reason, /no lleva URL/);
  });

  it("un fichero que no es un HAR lo dice", () => {
    assert.match(parseHar('{"info":{}}').skipped[0]!.reason, /log\.entries/);
    assert.match(parseHar("no es json").skipped[0]!.reason, /log\.entries/);
  });

  it("un HAR sin entradas no es un error: no hay nada que importar y ya está", () => {
    const read = parseHar(har([]));
    assert.deepEqual(read.requests, []);
    assert.deepEqual(read.skipped, []);
  });
});
