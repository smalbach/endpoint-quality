/**
 * Los ejemplos guardados, y sobre todo la redacción.
 *
 * Un ejemplo es exactamente el sitio donde una credencial se queda dormida para siempre: se guarda
 * una vez, nadie la vuelve a mirar, y sale en la exportación, en la documentación y en el
 * repositorio donde alguien commitea el fichero. Postman los guarda en claro. Así que casi todas
 * estas pruebas son de lo que **no** se guarda, y la mitad de ellas fallan sin romper nada visible:
 * el ejemplo se guarda igual, con el token dentro.
 *
 * La otra mitad va del otro riesgo, el simétrico: **tapar de más**. Un `session_id` que era un
 * identificador público, un `pin` que era un código postal, un identificador con dos puntos que
 * parece un JWT. Un ejemplo que ha perdido un campo que hacía falta se lee como el contrato del
 * endpoint, y entonces miente.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MASK,
  MAX_EXAMPLE_BODY,
  defaultExampleName,
  exampleProblems,
  looksLikeJwt,
  redactBody,
  redactExample,
  redactHeaders,
  uniqueExampleName,
  viewExample,
  type EndpointExample,
  type ExampleRequest,
  type ExampleResponse,
} from "@/modules/endpoints/domain/examples";

const header = (name: string, value = "x") => ({ name, value, enabled: true });

const request = (patch: Partial<ExampleRequest> = {}): ExampleRequest => ({
  method: "POST",
  url: "https://api.ejemplo.com/v1/sesiones",
  headers: [header("Content-Type", "application/json")],
  body: { text: '{"usuario":"ana"}', contentType: "application/json" },
  ...patch,
});

const response = (patch: Partial<ExampleResponse> = {}): ExampleResponse => ({
  status: 200,
  headers: [header("Content-Type", "application/json")],
  body: '{"id":7}',
  contentType: "application/json",
  durationMs: 42,
  ...patch,
});

describe("las cabeceras que no se guardan", () => {
  it("la credencial se va y se nombra", () => {
    const read = redactHeaders([header("Authorization", "Bearer abc"), header("Accept", "application/json")]);
    assert.deepEqual(
      read.headers.map((row) => row.name),
      ["Accept"],
    );
    assert.deepEqual(read.dropped, ["Authorization"]);
  });

  it("y la cookie, que es la sesión", () => {
    assert.deepEqual(redactHeaders([header("Cookie"), header("Set-Cookie")]).dropped, ["Cookie", "Set-Cookie"]);
  });

  it("una clave de API se llame como se llame", () => {
    const names = ["X-Api-Key", "api_key", "apikey", "X-Auth-Token", "mi-servicio-token", "algo-secret"];
    for (const name of names) {
      assert.deepEqual(redactHeaders([header(name)]).dropped, [name], name);
    }
  });

  it("el Content-Type se queda, que es la mitad de lo que documenta una respuesta", () => {
    // A diferencia del importador de peticiones guardadas, que sí lo tira: allí el ejecutor lo
    // deriva del cuerpo y uno viejo contradiría lo que de verdad se manda.
    const read = redactHeaders([header("Content-Type", "application/json"), header("ETag", 'W/"7"')]);
    assert.deepEqual(read.dropped, []);
    assert.equal(read.headers.length, 2);
  });

  it("y no se tapa una cabecera que solo contiene la palabra en medio", () => {
    // `X-Token-Expiry` no es el token: es cuándo caduca, y es información del ejemplo.
    assert.deepEqual(redactHeaders([header("X-Request-Id"), header("X-Total-Count")]).dropped, []);
  });
});

describe("reconocer un JWT por su forma", () => {
  /** Uno de verdad: cabecera `{"alg":"HS256","typ":"JWT"}`. */
  const jwt = [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
    Buffer.from('{"sub":"ana","exp":9999999999}').toString("base64url"),
    "ZmlybWFfZGVfZWplbXBsbw",
  ].join(".");

  it("un JWT lo es", () => {
    assert.equal(looksLikeJwt(jwt), true);
  });

  it("un identificador con puntos no lo es, por mucho que tenga tres trozos", () => {
    // Esta es la que evita tapar de más. Sin comprobar que el primer trozo decodifica a algo con
    // `alg`, cualquier `abcdefgh.ijklmnop.qrs` se tomaría por una credencial.
    assert.equal(looksLikeJwt("abcdefgh.ijklmnop.qrstuvwx"), false);
    assert.equal(looksLikeJwt("com.ejemplo.aplicacion"), false);
  });

  it("ni una cadena corta, ni una con dos trozos", () => {
    assert.equal(looksLikeJwt("a.b.c"), false);
    assert.equal(looksLikeJwt(`${jwt.split(".")[0]}.${jwt.split(".")[1]}`), false);
  });

  it("dentro de un cuerpo se tapa aunque el campo se llame «data»", () => {
    // El caso real: un login devuelve el token en un campo que ninguna lista de nombres atrapa.
    const read = redactBody(JSON.stringify({ data: jwt, nombre: "ana" }), "application/json");
    assert.match(read.body, new RegExp(MASK));
    assert.ok(!read.body.includes(jwt));
    assert.deepEqual(read.masked, ["data (JWT)"]);
    // Y lo que no era una credencial sigue ahí.
    assert.match(read.body, /"nombre": "ana"/);
  });

  it("y en la raíz del cuerpo, cuando la respuesta es el token pelado", () => {
    const read = redactBody(JSON.stringify(jwt), "application/json");
    assert.equal(read.body, JSON.stringify(MASK, null, 2));
    assert.deepEqual(read.masked, ["(raíz) (JWT)"]);
  });
});

describe("los campos del cuerpo que se tapan", () => {
  it("los que se llaman como una credencial, conservando la forma", () => {
    const read = redactBody(
      JSON.stringify({
        id: 7,
        access_token: "abc",
        refresh_token: "def",
        usuario: { password: "1234", nombre: "ana" },
      }),
      "application/json",
    );
    const parsed = JSON.parse(read.body) as Record<string, unknown>;
    assert.equal(parsed.id, 7, "lo que no es un secreto no se toca");
    assert.equal(parsed.access_token, MASK);
    assert.equal(parsed.refresh_token, MASK);
    assert.deepEqual(parsed.usuario, { password: MASK, nombre: "ana" });
    assert.deepEqual(read.masked.sort(), ["access_token", "refresh_token", "usuario.password"]);
  });

  it("un campo vacío también, porque un password en blanco dice algo", () => {
    const read = redactBody(JSON.stringify({ password: "" }), "application/json");
    assert.equal((JSON.parse(read.body) as Record<string, unknown>).password, MASK);
  });

  it("un null se queda null: no hay nada que tapar y taparlo cambiaría el tipo", () => {
    const read = redactBody(JSON.stringify({ token: null }), "application/json");
    assert.equal((JSON.parse(read.body) as Record<string, unknown>).token, null);
    assert.deepEqual(read.masked, []);
  });

  it("dentro de un array, con la ruta que dice cuál", () => {
    const read = redactBody(JSON.stringify([{ token: "a" }, { token: "b" }]), "application/json");
    assert.deepEqual(read.masked, ["[0].token", "[1].token"]);
  });

  it("y un campo que se parece pero no lo es se queda", () => {
    // Esta es la simétrica: `tokenCount` y `passwordPolicy` no son credenciales, y taparlos
    // rompería el ejemplo sin que nadie se enterase.
    const read = redactBody(
      JSON.stringify({ tokenCount: 3, passwordPolicy: "min 8", secretariaId: 9 }),
      "application/json",
    );
    assert.deepEqual(read.masked, []);
  });
});

describe("un cuerpo que no es JSON", () => {
  it("se deja tal cual y se dice que no se ha mirado dentro", () => {
    // Adivinar dónde está el secreto en un HTML con una expresión regular corta el ejemplo por la
    // mitad o tapa un identificador que hacía falta. Lo honesto es no mirar y decirlo.
    const html = "<html><body>hola</body></html>";
    const read = redactBody(html, "text/html");
    assert.equal(read.body, html);
    assert.equal(read.scanned, false);
    assert.deepEqual(read.masked, []);
  });

  it("un JSON roto tampoco se toca, y tampoco se da por revisado", () => {
    const read = redactBody('{"a": ', "application/json");
    assert.equal(read.body, '{"a": ');
    assert.equal(read.scanned, false);
  });

  it("un JSON sin Content-Type se reconoce por la llave", () => {
    // Un servidor que contesta `text/plain` con un JSON dentro es lo bastante común como para que
    // fiarse solo de la cabecera dejara el token sin tapar.
    const read = redactBody('{"token":"abc"}', "text/plain");
    assert.equal(read.scanned, true);
    assert.equal((JSON.parse(read.body) as Record<string, unknown>).token, MASK);
  });
});

describe("el par completo", () => {
  it("se limpia por los tres lados y se cuenta lo que se fue", () => {
    const clean = redactExample(
      request({ headers: [header("Authorization", "Bearer abc"), header("Accept", "*/*")] }),
      response({
        headers: [header("Set-Cookie", "sesion=abc"), header("Content-Type", "application/json")],
        body: JSON.stringify({ access_token: "abc", id: 7 }),
      }),
    );
    assert.deepEqual(clean.redaction.droppedHeaders, ["Authorization", "Set-Cookie"]);
    assert.deepEqual(clean.redaction.maskedFields, ["access_token"]);
    assert.equal(clean.redaction.bodyScanned, true);
    // Y lo que queda es utilizable: el Accept, el Content-Type y el id siguen ahí.
    assert.deepEqual(
      clean.request.headers.map((row) => row.name),
      ["Accept"],
    );
    assert.equal((JSON.parse(clean.response.body) as Record<string, unknown>).id, 7);
  });

  it("el cuerpo de la petición también, que es donde va la contraseña de un login", () => {
    const clean = redactExample(
      request({
        body: { text: JSON.stringify({ usuario: "ana", password: "1234" }), contentType: "application/json" },
      }),
      response(),
    );
    assert.ok(!clean.request.body.text.includes("1234"));
    assert.deepEqual(clean.redaction.maskedFields, ["password"]);
  });

  it("bodyScanned habla de la respuesta, que es el cuerpo que alguien va a leer como contrato", () => {
    const clean = redactExample(request(), response({ body: "<xml/>", contentType: "application/xml" }));
    assert.equal(clean.redaction.bodyScanned, false);
  });
});

describe("validar", () => {
  it("un estado que no es un código HTTP no entra", () => {
    for (const status of [0, 99, 600, 1.5, Number.NaN]) {
      const problems = exampleProblems({ response: response({ status }) });
      assert.ok(
        problems.some((problem) => problem.field === "response.status"),
        String(status),
      );
    }
  });

  it("un cuerpo enorme no es un ejemplo, es un volcado", () => {
    const problems = exampleProblems({ response: response({ body: "x".repeat(MAX_EXAMPLE_BODY + 1) }) });
    assert.match(problems[0]!.detail, /volcado/);
  });

  it("el límite se mide en bytes, no en caracteres", () => {
    // Justo por debajo en caracteres y justo por encima en bytes: con acentos la cuenta cambia, y
    // medir caracteres dejaría pasar cuerpos que no caben.
    const body = "á".repeat(MAX_EXAMPLE_BODY / 2 + 1);
    assert.ok(body.length <= MAX_EXAMPLE_BODY);
    assert.ok(exampleProblems({ response: response({ body }) }).length > 0);
  });

  it("un nombre en blanco se rechaza cuando se escribe, no cuando se omite", () => {
    assert.ok(exampleProblems({ name: "   " }).length > 0);
    assert.deepEqual(exampleProblems({}), []);
  });
});

describe("el nombre", () => {
  it("por defecto es el código, que es lo que se busca en la lista", () => {
    assert.equal(defaultExampleName(404), "404 no encontrado");
    assert.equal(defaultExampleName(200), "200 correcto");
    // Uno sin etiqueta sale como el número, no como «Ejemplo 1».
    assert.equal(defaultExampleName(418), "418");
  });

  it("se numera en vez de machacar el que ya estaba", () => {
    assert.equal(uniqueExampleName("200 correcto", new Set()), "200 correcto");
    assert.equal(uniqueExampleName("200 correcto", new Set(["200 correcto"])), "200 correcto 2");
    assert.equal(uniqueExampleName("200 correcto", new Set(["200 correcto", "200 correcto 2"])), "200 correcto 3");
  });
});

describe("cómo sale", () => {
  it("sin el proyecto, con las fechas en ISO y con el tamaño del cuerpo", () => {
    const example: EndpointExample = {
      id: "e1",
      projectId: "p1",
      endpointId: "en1",
      name: "200 correcto",
      request: request(),
      response: response({ body: '{"a":"ñ"}' }),
      origin: "manual",
      orderIndex: 0,
      createdAt: new Date("2026-03-01T10:00:00Z"),
      updatedAt: new Date("2026-03-01T10:00:00Z"),
      createdBy: "u1",
    };
    const view = viewExample(example);
    assert.ok(!("projectId" in view));
    assert.equal(view.createdAt, "2026-03-01T10:00:00.000Z");
    // 9 caracteres, 10 bytes: la «ñ» son dos.
    assert.equal(view.sizeBytes, 10);
  });
});
