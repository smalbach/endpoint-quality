/**
 * Los bordes de las funciones puras de endpoints y entornos que ninguna prueba pisaba: cabeceras
 * que llegan como `null` o partidas, nombres de ejemplo agotados, ficheros sin URL, placeholders
 * que la URL ya codificó, un JWT cuya carga no es un objeto, un entorno de Postman con filas raras.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  exampleProblems,
  MAX_EXAMPLE_HEADERS,
  uniqueExampleName,
  type ExampleResponse,
} from "@/modules/endpoints/domain/examples";
import { detectFormat, parseEndpointFile } from "@/modules/endpoints/domain/import-endpoints";
import { readSendInput, unfilledPlaceholders } from "@/modules/endpoints/domain/send-request";
import { credentialHeader } from "@/modules/environments/domain/model";
import { readPostmanEnvironment } from "@/modules/environments/domain/import-postman-environment";
import { decodeJwtClaims } from "@/modules/environments/domain/session-token";

const response = (fields: Partial<ExampleResponse> = {}): ExampleResponse => ({
  status: 200,
  headers: [],
  body: "{}",
  contentType: "application/json",
  durationMs: 1,
  ...fields,
});

describe("exampleProblems: las cabeceras de la respuesta", () => {
  test("unas cabeceras que no son lista se dicen y no se sigue mirando", () => {
    const problems = exampleProblems({ response: response({ headers: "x-a: 1" as never }) });
    assert.deepEqual(problems, [{ field: "response.headers", detail: "Las cabeceras son una lista" }]);
  });

  test("más cabeceras de las que caben es un problema con el tope en el texto", () => {
    const headers = Array.from({ length: MAX_EXAMPLE_HEADERS + 1 }, (_, index) => ({ name: `x-${index}`, value: "1", enabled: true }));
    const problems = exampleProblems({ response: response({ headers }) });
    assert.deepEqual(problems, [{ field: "response.headers", detail: `Como mucho ${MAX_EXAMPLE_HEADERS} cabeceras` }]);
  });

  test("una cabecera `null` no revienta, y un salto de línea en el nombre se señala por su índice", () => {
    const problems = exampleProblems({
      response: response({ headers: [null as never, { name: "x-a\r\nx-b", value: "1", enabled: true }, { name: "x-c" } as never] }),
    });
    assert.deepEqual(problems, [{ field: "response.headers.1", detail: "Una cabecera no lleva saltos de línea" }]);
  });
});

describe("uniqueExampleName", () => {
  test("un nombre en blanco se llama «Ejemplo»", () => {
    assert.equal(uniqueExampleName("   ", new Set()), "Ejemplo");
    assert.equal(uniqueExampleName("", new Set(["Ejemplo"])), "Ejemplo 2");
  });

  test("con los 999 números ocupados, el sufijo es aleatorio y no choca", () => {
    const taken = new Set(["Ok", ...Array.from({ length: 998 }, (_, index) => `Ok ${index + 2}`)]);
    const name = uniqueExampleName("Ok", taken);
    assert.match(name, /^Ok [0-9a-f]{8}$/);
    assert.equal(taken.has(name), false);
  });
});

describe("importar un fichero", () => {
  test("la extensión se lee de la última parte, y un nombre sin punto no tiene", () => {
    assert.equal(detectFormat("api.v2.YML", ""), "openapi");
    assert.equal(detectFormat("notas.md", "{}"), "markdown");
    assert.equal(detectFormat("sin-extension", "openapi: 3.0.0\n"), "openapi");
  });

  test("un salto que no trae URL queda con la ruta vacía", () => {
    const parsed = parseEndpointFile("postman", "no es json");
    assert.deepEqual(parsed.drafts, []);
    assert.deepEqual(parsed.skipped, [{ method: "", path: "", name: "", reason: "el fichero no es JSON" }]);
  });

  test("un salto con URL enseña solo su ruta", () => {
    const collection = {
      info: { name: "c", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        {
          name: "raro",
          request: { method: "GET", url: "https://api.test/v1/raro?x=1", auth: { type: "akamai" } },
        },
      ],
    };
    const parsed = parseEndpointFile("postman", JSON.stringify(collection));
    assert.deepEqual(parsed.drafts, []);
    assert.equal(parsed.skipped.length, 1);
    assert.equal(parsed.skipped[0].path, "/v1/raro");
    assert.equal(parsed.skipped[0].method, "GET");
    assert.match(parsed.skipped[0].reason, /akamai/);
  });
});

describe("readSendInput y los placeholders", () => {
  test("un auth que no vale es un problema y no llega a la entrada", () => {
    const read = readSendInput(JSON.stringify({ method: "GET", path: "/x", auth: { type: "nada" } }));
    assert.ok("problems" in read);
    assert.deepEqual(read.problems.map((problem) => problem.field), ["auth.type"]);
  });

  test("sin auth, la entrada hereda", () => {
    const read = readSendInput(JSON.stringify({ method: "GET", path: "/x" }));
    assert.ok("input" in read);
    assert.deepEqual(read.input.auth, { type: "inherit", params: {} });
  });

  test("los placeholders sin rellenar salen con su nombre, escritos con llaves o ya codificados", () => {
    assert.deepEqual(unfilledPlaceholders("http://api.test/users/{id}/posts/%7BpostId%7D"), ["id", "postId"]);
    assert.deepEqual(unfilledPlaceholders("/users/{{x}}"), ["x"]);
    assert.deepEqual(unfilledPlaceholders("/users/42"), []);
  });
});

describe("entornos: dominio", () => {
  test("una API key sin nombre de cabecera viaja en X-API-Key", () => {
    assert.deepEqual(credentialHeader({ kind: "api_key", headerName: null } as never, "k"), { "X-API-Key": "k" });
    assert.deepEqual(credentialHeader({ kind: "api_key", headerName: "" } as never, "k"), { "X-API-Key": "k" });
    assert.deepEqual(credentialHeader({ kind: "api_key", headerName: "X-Clave" } as never, "k"), { "X-Clave": "k" });
  });

  test("un JWT cuya carga es una lista, un número o JSON roto no tiene claims", () => {
    const jwt = (payload: string) => `h.${Buffer.from(payload).toString("base64url")}.s`;
    assert.equal(decodeJwtClaims(jwt("[1,2]")), null);
    assert.equal(decodeJwtClaims(jwt("7")), null);
    assert.equal(decodeJwtClaims(jwt("{no")), null);
    assert.deepEqual(decodeJwtClaims(jwt('{"sub":"ana"}')), { sub: "ana" });
  });

  test("Postman: una fila que no es objeto se ignora, y `name` vale cuando no hay `key`", () => {
    const draft = readPostmanEnvironment(
      JSON.stringify({
        name: "Local",
        values: ["suelta", null, { key: "", value: "x" }, { name: "host", value: "http://h" }, { key: "token", value: "t" }],
      }),
    );
    assert.ok(draft);
    assert.deepEqual(Object.keys(draft.variables).sort(), ["host", "token"]);
    assert.deepEqual(draft.skipped, []);
  });
});
