/**
 * Un entorno de Postman, leído como entorno de este proyecto.
 *
 * La tercera cosa que trae una exportación, después de las URL y los tests, y sin la cual las otras
 * dos no corren: una colección escrita contra `{{baseUrl}}` y `{{access_token}}` no hace nada hasta
 * que alguien da esos dos nombres.
 *
 * Lo que fijan estas pruebas es lo que no se puede equivocar sin que se note tarde: que un secreto
 * de Postman llegue marcado como secreto —aquí eso decide que el valor va cifrado en la columna y
 * que sale enmascarado—, que una fila apagada siga apagada, y que la URL base salga de una variable
 * **sin dejar de ser una variable**, porque cada `{{baseUrl}}/v1/x` de los flujos la busca por su
 * nombre.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { postmanDocumentKind, readPostmanEnvironment } from "@/modules/environments/domain/import-postman-environment";

/** El fichero de entorno que genera Postman, con la forma exacta de uno real. */
const environment = (values: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "6b1e",
    name: "Catalog API — local",
    values,
    _postman_variable_scope: "environment",
    ...extra,
  });

const row = (key: string, value: string, patch: Record<string, unknown> = {}) => ({
  key,
  value,
  type: "default",
  enabled: true,
  ...patch,
});

describe("qué es cada fichero de Postman", () => {
  test("se distingue por su forma, no por su nombre: lo que baja Postman se llama como sea", () => {
    assert.equal(postmanDocumentKind(environment([row("baseUrl", "http://x")])), "environment");
    assert.equal(postmanDocumentKind(JSON.stringify({ info: { name: "c" }, item: [] })), "collection");
    assert.equal(postmanDocumentKind('{"nada": 1}'), null);
    assert.equal(postmanDocumentKind("no soy json"), null);
  });
});

describe("las variables de un entorno de Postman", () => {
  test("un `type: secret` llega marcado como sensible, que aquí decide que va cifrado", () => {
    const draft = readPostmanEnvironment(
      environment([
        row("baseUrl", "http://localhost:8000"),
        row("access_token", "eyJhbGciOi", { type: "secret" }),
        row("scope", "catalog:read"),
      ]),
    )!;
    assert.equal(draft.variables.access_token.sensitive, true);
    assert.equal(draft.variables.scope.sensitive, false);
  });

  test("una fila apagada en Postman sigue apagada aquí", () => {
    const draft = readPostmanEnvironment(
      environment([row("baseUrl", "http://localhost:8000"), row("api_key", "k", { enabled: false })]),
    )!;
    assert.deepEqual(Object.keys(draft.variables), ["baseUrl"]);
    assert.deepEqual(Object.keys(draft.disabledVariables), ["api_key"]);
  });

  test("la URL base sale de una variable y **sigue siendo** una variable", () => {
    // Las dos mitades importan: sin la columna el entorno no se puede guardar, y sin la variable
    // cada `{{baseUrl}}/v1/products` de los flujos se queda sin resolver.
    const draft = readPostmanEnvironment(environment([row("baseUrl", "https://api.ara.com/")]))!;
    assert.equal(draft.baseUrl, "https://api.ara.com");
    assert.equal(draft.baseUrlFrom, "baseUrl");
    assert.equal(draft.variables.baseUrl.initial, "https://api.ara.com/");
  });

  test("un nombre que no es una URL absoluta no se toma por la URL base", () => {
    // `token_url` es una URL y no es la del API; `host` sin esquema no se puede usar como base.
    const draft = readPostmanEnvironment(
      environment([row("host", "api.ara.com"), row("token_url", "https://api.ara.com/oauth2/token")]),
    )!;
    assert.equal(draft.baseUrl, "");
    assert.equal(draft.baseUrlFrom, null);
  });

  test("los secretos en blanco se avisan: un token vacío falla con un 401 que no habla del endpoint", () => {
    const draft = readPostmanEnvironment(
      environment([
        row("baseUrl", "http://localhost:8000"),
        row("client_secret", "", { type: "secret" }),
        row("access_token", "", { type: "secret" }),
      ]),
    )!;
    assert.match(draft.notes.join(" "), /client_secret, access_token/);
  });

  test("un nombre que no vale como variable se dice, no se renombra", () => {
    const draft = readPostmanEnvironment(environment([row("baseUrl", "http://x"), row("mi variable", "1")]))!;
    assert.deepEqual(draft.skipped, [
      { name: "mi variable", reason: "el nombre no vale como variable: empieza por letra o «_»" },
    ]);
  });

  test("las variables que una colección se guarda para sí también entran", () => {
    // Postman separa los ámbitos; este motor tiene **un** mapa plano de variables, así que la
    // distinción no sobrevive — y las de la colección hacen tanta falta como las del entorno.
    const draft = readPostmanEnvironment(
      JSON.stringify({ info: { name: "Catálogo" }, item: [], variable: [row("chk_run", "1")] }),
    )!;
    assert.equal(draft.variables.chk_run.initial, "1");
    assert.equal(draft.name, "Catálogo");
  });

  test("un ámbito que no es «environment» entra igual y se dice", () => {
    const draft = readPostmanEnvironment(
      environment([row("baseUrl", "http://x")], { _postman_variable_scope: "globals" }),
    )!;
    assert.match(draft.notes.join(" "), /globals/);
  });

  test("lo que no es JSON no es un entorno", () => {
    assert.equal(readPostmanEnvironment("no soy json"), null);
  });
});
