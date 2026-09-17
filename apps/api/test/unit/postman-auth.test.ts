/**
 * El bloque `auth` de Postman: leerlo, heredarlo, y escribirlo de vuelta sin el secreto.
 *
 * Lo que estas pruebas cubren es lo que antes no existía: el lector tiraba el bloque entero y en
 * silencio. Una colección real lleva su autenticación arriba y las peticiones la heredan, así que
 * perderlo dejaba todas las peticiones importadas contestando 401 sin motivo visible.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RequestAuth } from "@eq/runner-core";

import {
  isReadable,
  readPostmanAuth,
  redactAuth,
  resolveAuth,
  writePostmanAuth,
} from "@/modules/workflows/domain/postman-auth";

const read = (value: unknown) => {
  const result = readPostmanAuth(value);
  assert.ok(result && isReadable(result));
  return result;
};

describe("leer el bloque", () => {
  test("la lista de {key, value} de v2.1", () => {
    assert.deepEqual(
      read({
        type: "basic",
        basic: [
          { key: "username", value: "ana", type: "string" },
          { key: "password", value: "{{pass}}", type: "string" },
        ],
      }),
      { type: "basic", params: { username: "ana", password: "{{pass}}" } },
    );
  });

  test("y el objeto plano de los ficheros viejos o editados a mano", () => {
    assert.deepEqual(read({ type: "bearer", bearer: { token: "{{token}}" } }), {
      type: "bearer",
      params: { token: "{{token}}" },
    });
  });

  test("`noauth` es «esta no se autentica», que no es lo mismo que no tener bloque", () => {
    assert.deepEqual(read({ type: "noauth" }), { type: "none", params: {} });
    assert.equal(readPostmanAuth(undefined), null);
    assert.equal(readPostmanAuth({}), null);
  });

  test("un tipo que no conocemos se nombra en vez de pasar por «sin autenticación»", () => {
    const result = readPostmanAuth({ type: "asap", asap: [] });
    assert.ok(result && !isReadable(result));
    assert.equal(result.unsupported, "asap");
  });

  test("los trece tipos de Postman se reconocen", () => {
    for (const type of [
      "basic",
      "bearer",
      "apikey",
      "jwt",
      "digest",
      "oauth1",
      "oauth2",
      "hawk",
      "awsv4",
      "edgegrid",
      "ntlm",
    ]) {
      assert.equal(read({ type, [type]: [] }).type, type, type);
    }
  });
});

describe("la herencia, que es donde está la autenticación de verdad", () => {
  const collection = { type: "bearer" as const, params: { token: "{{colToken}}" } };
  const folder = { type: "basic" as const, params: { username: "carpeta" } };

  test("una petición sin bloque hereda la carpeta más cercana", () => {
    assert.deepEqual(resolveAuth(null, { collection, folders: [null, folder] }), folder);
  });

  test("y la colección cuando ninguna carpeta dice nada", () => {
    assert.deepEqual(resolveAuth(null, { collection, folders: [null, null] }), collection);
  });

  test("la propia gana siempre", () => {
    const own = { type: "apikey" as const, params: { key: "X-K" } };
    assert.deepEqual(resolveAuth(own, { collection, folders: [folder] }), own);
  });

  test("`noauth` propio no hereda: es una decisión, no un hueco", () => {
    assert.deepEqual(resolveAuth({ type: "none", params: {} }, { collection, folders: [folder] }), {
      type: "none",
      params: {},
    });
  });

  test("sin nada en ningún sitio, hereda la del proyecto", () => {
    assert.deepEqual(resolveAuth(null, { collection: null, folders: [] }), { type: "inherit", params: {} });
  });
});

describe("los secretos no se guardan en claro", () => {
  test("una contraseña literal se queda vacía y se nombra", () => {
    const result = redactAuth({ type: "basic", params: { username: "ana", password: "hunter2" } });
    assert.deepEqual(result.auth.params, { username: "ana", password: "" });
    assert.deepEqual(result.dropped, ["password"]);
  });

  test("un valor que es solo {{variables}} se queda: es el nombre, no el secreto", () => {
    const result = redactAuth({ type: "basic", params: { username: "ana", password: "{{pass}}" } });
    assert.equal(result.auth.params.password, "{{pass}}");
    assert.deepEqual(result.dropped, []);
  });

  test("en una clave de API el secreto es `value`, y el nombre de la cabecera no", () => {
    const result = redactAuth({ type: "apikey", params: { key: "X-API-Key", value: "abc123" } });
    assert.equal(result.auth.params.key, "X-API-Key");
    assert.equal(result.auth.params.value, "");
    assert.deepEqual(result.dropped, ["value"]);
  });

  test("la firma de AWS pierde la secret key y conserva la región", () => {
    const result = redactAuth({
      type: "awsv4",
      params: { accessKey: "AKIA…", secretKey: "s3cr3t", region: "eu-west-1" },
    });
    assert.equal(result.auth.params.secretKey, "");
    assert.equal(result.auth.params.region, "eu-west-1");
  });
});

describe("escribirlo de vuelta", () => {
  test("sale con el nombre de Postman y sus parámetros en lista", () => {
    const written = writePostmanAuth({ type: "basic", params: { username: "ana", password: "{{pass}}" } });
    assert.deepEqual(written.block, {
      type: "basic",
      basic: [
        { key: "username", value: "ana", type: "string" },
        { key: "password", value: "{{pass}}", type: "string" },
      ],
    });
    assert.deepEqual(written.redacted, []);
  });

  test("`none` sale como `noauth`, que es como lo llama Postman", () => {
    assert.deepEqual(writePostmanAuth({ type: "none", params: {} }).block, { type: "noauth" });
  });

  test("`inherit` no escribe nada, que es lo que significa en su fichero", () => {
    assert.equal(writePostmanAuth({ type: "inherit", params: {} }).block, null);
  });

  test("un secreto literal sale vacío y se avisa", () => {
    const written = writePostmanAuth({ type: "bearer", params: { token: "eyJhbGciOi" } });
    assert.deepEqual(written.redacted, ["token"]);
    const entries = written.block?.bearer as { key: string; value: string }[];
    assert.deepEqual(entries, [{ key: "token", value: "", type: "string" }]);
  });

  test("lo escrito vuelve a leerse igual, que es lo que hace un fichero reimportable", () => {
    const cases: RequestAuth[] = [
      { type: "basic", params: { username: "a", password: "{{p}}" } },
      { type: "apikey", params: { key: "X-K", value: "{{k}}", in: "query" } },
      { type: "awsv4", params: { accessKey: "AK", secretKey: "{{sk}}", region: "eu-west-1" } },
      { type: "oauth2", params: { accessToken: "{{t}}", addTokenTo: "header" } },
    ];
    for (const auth of cases) {
      const written = writePostmanAuth(auth);
      assert.ok(written.block);
      assert.deepEqual(read(written.block), auth, auth.type);
    }
  });
});
