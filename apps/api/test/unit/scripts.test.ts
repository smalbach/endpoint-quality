/**
 * Scripts: the sandbox as a real process, what comes back from it read as untrusted, the console
 * with secrets masked, and what a script's writes do to an environment.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ProcessScriptSandbox } from "@/shared/scripts/process-script-sandbox";
import { redactOutcome, sanitizeOutcome, type ScriptInput } from "@/shared/scripts/script-sandbox";
import { applyScriptWrites, type Environment } from "@/modules/environments/domain/model";
import { decodeJwtClaims, expiryOf, isExpired, viewSessionToken } from "@/modules/environments/domain/session-token";

const sandbox = new ProcessScriptSandbox();

const input = (code: string, patch: Partial<ScriptInput> = {}): ScriptInput => ({
  phase: "pre",
  code,
  environment: { name: "local", values: { userId: "42", apiKey: "clave-secreta" } },
  variables: {},
  request: { method: "GET", url: "/users/{{userId}}", headers: { Accept: "application/json" }, body: null },
  response: null,
  ...patch,
});

describe("el proceso del script", () => {
  test("el script previo lee y escribe el entorno, fija variables de la petición y cambia cabeceras", async () => {
    const outcome = await sandbox.run(
      input(`
        pm.environment.set("ts", 1700000000);
        pm.variables.set("page", 2);
        pm.request.headers.upsert({ key: "X-Signature", value: btoa(pm.environment.get("userId")) });
        pm.request.headers.remove("accept");
        console.log("usuario", env.get("userId"), { nested: true });
        console.warn("cuidado");
      `),
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.environmentSet, { ts: "1700000000" });
    assert.deepEqual(outcome.variables, { page: "2" });
    assert.deepEqual(outcome.headers, { "X-Signature": "NDI=" });
    assert.deepEqual(outcome.logs, [
      { level: "log", text: 'usuario 42 {\n  "nested": true\n}' },
      { level: "warn", text: "cuidado" },
    ]);
  });

  test("el posterior lee la respuesta y sus pruebas dicen qué falló, sin cortar las demás", async () => {
    const outcome = await sandbox.run(
      input(
        `
        const body = pm.response.json();
        pm.test("200", () => pm.response.to.have.status(200));
        pm.test("id", () => pm.expect(body.id).to.equal(8));
        pm.test("lista", () => { pm.expect(body.items).to.be.an("array").that.is.not.empty; });
        pm.test("propiedad", () => pm.expect(body).to.have.property("token"));
        pm.environment.set("token", body.token);
        pm.environment.unset("viejo");
      `,
        {
          phase: "post",
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: '{"id":7,"items":[1],"token":"abc"}',
            durationMs: 12,
          },
        },
      ),
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.tests.map((test) => [test.name, test.passed, test.message]),
      [
        ["200", true, null],
        ["id", false, "se esperaba 8 y llegó 7"],
        ["lista", true, null],
        ["propiedad", true, null],
      ],
    );
    assert.deepEqual(outcome.environmentSet, { token: "abc" });
    assert.deepEqual(outcome.environmentUnset, ["viejo"]);
    assert.equal(outcome.headers, null);
  });

  test("un error dice su línea y conserva lo que se escribió antes", async () => {
    const outcome = await sandbox.run(input('console.log("antes");\n\nnull.campo;'));
    assert.equal(outcome.error, "TypeError: Cannot read properties of null (reading 'campo') (línea 3)");
    assert.deepEqual(outcome.logs, [{ level: "log", text: "antes" }]);
  });

  test("no hay salida del contexto: ni constructor, ni process, ni require", async () => {
    for (const code of [
      'this.constructor.constructor("return process")()',
      'pm.test.constructor("return process")()',
      "eval('1')",
    ]) {
      const outcome = await sandbox.run(input(code));
      assert.match(outcome.error ?? "", /EvalError: Code generation from strings disallowed/, code);
    }
    const globals = await sandbox.run(
      input("console.log(typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.Buffer)"),
    );
    assert.equal(globals.logs[0].text, "undefined undefined undefined undefined undefined");
  });

  test("las cabeceras solo se tocan antes de enviar", async () => {
    const outcome = await sandbox.run(
      input('pm.request.headers.add({ key: "X", value: "1" })', {
        phase: "post",
        response: { status: 200, headers: {}, body: "", durationMs: 1 },
      }),
    );
    assert.match(outcome.error ?? "", /solo se cambian en el script previo/);
  });

  test("un bucle sin fin se corta", { timeout: 15_000 }, async () => {
    const outcome = await sandbox.run(input("while (true) {}"));
    assert.match(outcome.error ?? "", /tardó más de 3 s/);
  });
});

/**
 * Lo que una colección de Postman de verdad usa, y que el sandbox tenía que aprender.
 *
 * Sale de pasar una colección generada —53 peticiones, 54 scripts— por el sandbox y mirar cuáles
 * reventaban. Ninguna de estas cinco cosas es exótica: son las que escribe cualquiera que haya
 * escrito tests en Postman, y sin ellas un script importado no falla por lo que afirma, sino con un
 * `TypeError` a la primera línea. **Un rojo que no es sobre el destino es peor que no importar.**
 */
describe("la superficie que una colección de Postman espera", () => {
  const post = (code: string, response: Partial<ScriptInput["response"]> = {}) =>
    sandbox.run(
      input(code, {
        phase: "post",
        request: { method: "GET", url: "/v1/products?code_sap=MAT-1&limit=20", headers: {}, body: null },
        response: {
          status: 200,
          headers: { "content-type": "application/problem+json" },
          body: JSON.stringify({ data: [{ id: 7 }], meta: { next_cursor: "c1" }, links: { self: "/v1/products" } }),
          durationMs: 9,
          ...response,
        },
      }),
    );

  test("collectionVariables y globals son el mismo almacén de la corrida que pm.variables", async () => {
    const outcome = await post(
      'pm.collectionVariables.set("uno", "1"); pm.globals.set("dos", "2"); pm.variables.set("tres", pm.collectionVariables.get("uno"));',
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.variables, { uno: "1", dos: "2", tres: "1" });
    // Y **no** en el entorno guardado: una variable de colección nunca estuvo ahí, y un script de
    // endpoint que las escribiera dejaría cuarenta filas detrás.
    assert.deepEqual(outcome.environmentSet, {});
  });

  test("collectionVariables.get cae en lo que la corrida ya sabe", async () => {
    const outcome = await post(
      'pm.test("lee", function () { pm.expect(pm.collectionVariables.get("userId")).to.eql("42"); });',
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.tests, [{ name: "lee", passed: true, message: null }]);
  });

  test("to.have.all.keys es «exactamente esas» y to.have.any.keys «al menos una»", async () => {
    const outcome = await post(
      [
        "const body = pm.response.json();",
        'pm.test("todas", function () { pm.expect(body).to.have.all.keys("data", "meta", "links"); });',
        'pm.test("alguna", function () { pm.expect(body).to.have.any.keys("meta", "no-existe"); });',
        'pm.test("sobra una", function () { pm.expect(body).to.have.all.keys("data", "meta"); });',
      ].join("\n"),
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.tests.map((entry) => [entry.name, entry.passed]),
      [
        ["todas", true],
        ["alguna", true],
        // La diferencia que obliga a que `all` y `any` no sean ruido: con `all` sobrar una clave es
        // un fallo, y tratarlas como palabras de adorno convertiría una afirmación en la otra.
        ["sobra una", false],
      ],
    );
  });

  test("las cabeceras de la respuesta se leen por las dos vías", async () => {
    const outcome = await post(
      'pm.test("ct", function () { pm.expect(pm.response.headers.get("Content-Type")).to.include("problem+json"); pm.expect(pm.response.headers["content-type"]).to.include("problem+json"); });',
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.tests, [{ name: "ct", passed: true, message: null }]);
  });

  test("pm.request.url sigue siendo su texto y además trae la query", async () => {
    const outcome = await post(
      [
        'pm.test("texto", function () { pm.expect(String(pm.request.url)).to.include("code_sap"); });',
        'pm.test("query", function () {',
        "  const sent = pm.request.url.query.filter(function (p) { return !p.disabled; });",
        "  pm.expect(sent.length).to.eql(2);",
        '  pm.expect(sent[0].key).to.eql("code_sap");',
        '  pm.expect(sent[0].value).to.eql("MAT-1");',
        "});",
      ].join("\n"),
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(
      outcome.tests.map((entry) => entry.passed),
      [true, true],
    );
  });

  test("variables.unset olvida el nombre de la petición y no toca el entorno guardado", async () => {
    const outcome = await post('pm.variables.set("x", "1"); pm.collectionVariables.unset("x");');
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.variables, {});
    assert.deepEqual(outcome.environmentUnset, []);
  });
});

describe("lo que vuelve del proceso", () => {
  test("se lee sin fiarse: tipos, tamaños y nombres de variable", () => {
    const outcome = sanitizeOutcome(
      {
        error: 42,
        logs: [{ level: "shout", text: "x".repeat(5000) }, "no es un log"],
        tests: [{ name: "t", passed: "sí" }],
        environmentSet: { ok: "1", "no vale": "2", numero: 3 },
        environmentUnset: ["bien", "mal nombre", 7],
        variables: [],
        headers: { A: "1", B: 2 },
      },
      5,
    );
    assert.equal(outcome.error, null);
    assert.equal(outcome.logs.length, 1);
    assert.equal(outcome.logs[0].level, "log");
    assert.equal(outcome.logs[0].text.length, 2001);
    assert.deepEqual(outcome.tests, [{ name: "t", passed: false, message: null }]);
    assert.deepEqual(outcome.environmentSet, { ok: "1" });
    assert.deepEqual(outcome.environmentUnset, ["bien"]);
    assert.deepEqual(outcome.variables, {});
    assert.deepEqual(outcome.headers, { A: "1" });
    assert.match(sanitizeOutcome("basura", 1).error ?? "", /no devolvió un resultado legible/);
  });

  test("la consola no enseña secretos, ni en logs ni en pruebas ni en el error", () => {
    const outcome = redactOutcome(
      {
        ...sanitizeOutcome({}, 1),
        error: "Error: falló con clave-secreta",
        logs: [{ level: "log", text: "token=clave-secreta y abc" }],
        tests: [{ name: "clave-secreta", passed: false, message: "llegó clave-secreta" }],
      },
      ["clave-secreta", "abc"],
    );
    assert.equal(outcome.error, "Error: falló con ••••••••");
    assert.equal(outcome.logs[0].text, "token=•••••••• y abc");
    assert.deepEqual(outcome.tests[0], { name: "••••••••", passed: false, message: "llegó ••••••••" });
  });
});

describe("lo que un script escribe en el entorno", () => {
  const environment: Environment = {
    id: "e",
    projectId: "p",
    name: "local",
    baseUrl: "http://x",
    specUrl: null,
    variables: {
      userId: { initial: "42", current: "", sensitive: false },
      token: { initial: "v1.inicial", current: "", sensitive: true },
    },
    disabledVariables: { legacy: { initial: "7", current: "7", sensitive: false } },
    writesAllowed: false,
    authEnforced: false,
    createdAt: new Date(0),
  };

  test("solo el valor actual; un secreto sigue cifrado; lo nuevo se crea; unset vacía", () => {
    const next = applyScriptWrites(
      environment,
      { userId: "43", token: "nuevo", legacy: "8", nueva: "x" },
      ["userId"],
      (plain) => `cifrado(${plain})`,
    );
    assert.deepEqual(next.variables.userId, { initial: "42", current: "", sensitive: false });
    assert.deepEqual(next.variables.token, { initial: "v1.inicial", current: "cifrado(nuevo)", sensitive: true });
    assert.deepEqual(next.disabledVariables.legacy, { initial: "7", current: "8", sensitive: false });
    assert.deepEqual(next.variables.nueva, { initial: "", current: "x", sensitive: false });
    assert.equal(environment.variables.userId.current, "", "no muta el original");
  });
});

describe("el token de sesión", () => {
  const jwt = (payload: object) =>
    `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.firma`;

  test("lee los claims de un JWT, su caducidad, y no revela el token", () => {
    const token = jwt({ sub: "u-1", exp: 1_800_000_000, role: "admin" });
    const claims = decodeJwtClaims(token);
    assert.deepEqual(claims, { sub: "u-1", exp: 1_800_000_000, role: "admin" });
    const expiresAt = expiryOf(claims);
    assert.equal(expiresAt?.toISOString(), "2027-01-15T08:00:00.000Z");
    assert.equal(decodeJwtClaims("no-es-un-jwt"), null);
    assert.equal(expiryOf(null), null);

    const stored = {
      actorId: "a",
      projectId: "p",
      tokenCiphertext: "v1",
      claims,
      expiresAt,
      capturedAt: new Date(0),
      source: "login" as const,
    };
    assert.equal(isExpired(stored, new Date("2027-01-15T08:00:00.000Z")), true);
    const view = viewSessionToken(stored, token, new Date("2026-01-01T00:00:00Z"));
    assert.equal(view.expired, false);
    assert.equal(view.preview.includes("firma") || view.preview === token, false);
    assert.equal(viewSessionToken(stored, "corto", new Date(0)).preview, "••••••••");
  });
});
