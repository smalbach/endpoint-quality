/**
 * The active environment, the session token and the scripts of «Enviar», through the API and
 * against a real server on loopback.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

/** Answers every request with what it received, and counts them. */
let echo: Server;
let origin: string;
let hits = 0;

let owner: Actor;
let outsider: Actor;
let projectId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

const jwt = (payload: object) =>
  `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.firma-de-prueba`;

const send = (body: Record<string, unknown>) =>
  api().post(`${base()}/endpoints/send`).set(as(owner)).field("request", JSON.stringify(body));

async function environments(): Promise<
  { id: string; name: string; active: boolean; variables: Record<string, { initial: string; current: string }> }[]
> {
  const list = await api().get(`${base()}/environments`).set(as(owner));
  assert.equal(list.status, 200);
  return list.body;
}

async function createEnvironment(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await api()
    .post(`${base()}/environments`)
    .set(as(owner))
    .send({ name, baseUrl: origin, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.environmentId;
}

before(async () => {
  echo = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: incoming.method,
          url: incoming.url,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;

  context = await createTestApp();
  owner = await signUp("entornos@example.com");
  outsider = await signUp("entornos-ajeno@example.com");

  // The login answers with the body it was sent, so `tokenPath: "body"` is whatever the request
  // carried — a JWT typed in the editor, or the project's own login body.
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({
      name: "Con login",
      baseUrl: origin,
      auth: {
        type: "bearer",
        loginUrl: "/auth/login",
        loginMethod: "POST",
        tokenPath: "body",
        loginBody: '{"user":"demo"}',
      },
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  projectId = created.body.projectId;
});

after(async () => {
  await context?.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

describe("el entorno activo", () => {
  test("el primero queda activo; activar otro lo cambia; borrar el activo promueve el que queda", async () => {
    const first = await createEnvironment("local");
    const project = await api().get(base()).set(as(owner));
    assert.equal(project.body.activeEnvironmentId, first);

    const second = await createEnvironment("staging");
    assert.deepEqual(
      (await environments()).map((environment) => [environment.name, environment.active]),
      [
        ["local", true],
        ["staging", false],
      ],
    );

    const activated = await api().post(`${base()}/environments/${second}/activate`).set(as(owner));
    assert.equal(activated.status, 204);
    assert.equal((await environments()).find((environment) => environment.active)?.id, second);

    const removed = await api().delete(`${base()}/environments/${second}`).set(as(owner));
    assert.equal(removed.status, 204);
    assert.equal((await environments()).find((environment) => environment.active)?.id, first);
  });

  test("activar un entorno de otra organización es 404", async () => {
    const [environment] = await environments();
    const response = await api()
      .post(`/orgs/${outsider.organizationId}/projects/${projectId}/environments/${environment.id}/activate`)
      .set(as(outsider));
    assert.equal(response.status, 404);
  });
});

describe("el token de sesión", () => {
  test("enviar el login lo captura, la siguiente petición lo usa y olvidarlo vuelve al login del proyecto", async () => {
    const empty = await api().get(`${base()}/session-token`).set(as(owner));
    assert.deepEqual(empty.body, { token: null });

    const token = jwt({ sub: "user-7", role: "admin", exp: 1_900_000_000, iat: 1_700_000_000 });
    const login = await send({
      method: "POST",
      path: "/auth/login",
      body: { mode: "raw", text: token, contentType: "text/plain" },
      auth: { mode: "none" },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.sessionToken, "login");

    const stored = await api().get(`${base()}/session-token`).set(as(owner));
    assert.equal(stored.body.token.source, "login");
    assert.equal(stored.body.token.expired, false);
    assert.equal(stored.body.token.claims.sub, "user-7");
    assert.equal(stored.body.token.expiresAt, new Date(1_900_000_000_000).toISOString());
    assert.equal(JSON.stringify(stored.body).includes(token), false);
    // Somebody else in the same project has their own session, not this one.
    const [row] = [...context.repositories.sessionTokens.rows.values()];
    assert.equal(row.tokenCiphertext.includes("user-7"), false);

    const me = await send({ method: "GET", path: "/me" });
    assert.equal(me.body.auth, "Token de sesión (del login)");
    assert.equal(JSON.parse(me.body.response.body).headers.authorization, `Bearer ${token}`);

    const cleared = await api().delete(`${base()}/session-token`).set(as(owner));
    assert.equal(cleared.status, 204);
    const again = await send({ method: "GET", path: "/me" });
    assert.equal(again.body.auth, "Login del proyecto");
    assert.equal(JSON.parse(again.body.response.body).headers.authorization, 'Bearer {"user":"demo"}');
  });

  test("uno caducado no se usa, y la respuesta lo dice", async () => {
    await send({
      method: "POST",
      path: "/auth/login",
      body: { mode: "raw", text: jwt({ sub: "viejo", exp: 1_700_000_000 }), contentType: "text/plain" },
      auth: { mode: "none" },
    });
    const stored = await api().get(`${base()}/session-token`).set(as(owner));
    assert.equal(stored.body.token.expired, true);
    const me = await send({ method: "GET", path: "/me" });
    assert.equal(me.body.auth, "Login del proyecto · el token de sesión caducó");
    await api().delete(`${base()}/session-token`).set(as(owner));
  });
});

describe("los scripts de «Enviar»", () => {
  let environmentId: string;
  before(async () => {
    environmentId = await createEnvironment("scripts", {
      variables: { apiSecret: { initial: "secreto-del-api", current: "", sensitive: true } },
    });
  });

  test("el previo prepara la petición, el posterior prueba y guarda; la consola no enseña secretos", async () => {
    const response = await send({
      environmentId,
      method: "GET",
      path: "/items/{{itemId}}",
      query: [{ name: "q", value: "{{busqueda}}", enabled: true }],
      auth: { mode: "none" },
      preRequestScript: [
        'pm.environment.set("itemId", "9");',
        'pm.variables.set("busqueda", "zapatos");',
        'pm.request.headers.upsert({ key: "X-Sig", value: pm.environment.get("apiSecret") });',
        'console.log("firmando con", pm.environment.get("apiSecret"));',
      ].join("\n"),
      postResponseScript: [
        "const echoed = pm.response.json();",
        'pm.test("la url lleva el id", () => pm.expect(echoed.url).to.include("/items/9"));',
        'pm.test("esta falla", () => pm.expect(pm.response.code).to.equal(201));',
        'pm.environment.set("lastUrl", echoed.url);',
      ].join("\n"),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const echoed = JSON.parse(response.body.response.body);
    assert.equal(echoed.url, "/items/9?q=zapatos");
    assert.equal(echoed.headers["x-sig"], "secreto-del-api");

    const { pre, post } = response.body.scripts;
    assert.deepEqual(pre.logs, [{ level: "log", text: "firmando con ••••••••" }]);
    assert.deepEqual(pre.environmentUpdates, ["itemId"]);
    assert.equal(pre.error, null);
    assert.deepEqual(
      post.tests.map((test: { name: string; passed: boolean }) => [test.name, test.passed]),
      [
        ["la url lleva el id", true],
        ["esta falla", false],
      ],
    );
    assert.equal(response.body.sessionToken, null);
    assert.equal(JSON.stringify(response.body.scripts).includes("secreto-del-api"), false);

    const stored = (await environments()).find((environment) => environment.id === environmentId)!;
    assert.deepEqual(stored.variables.itemId, { initial: "", current: "9", sensitive: false });
    assert.equal(stored.variables.lastUrl.current, "/items/9?q=zapatos");
    assert.equal(stored.variables.busqueda, undefined, "pm.variables no se guarda");
  });

  test("si el previo falla, la petición no sale", async () => {
    const before = hits;
    const response = await send({
      environmentId,
      method: "GET",
      path: "/items/1",
      preRequestScript: 'console.log("voy");\nthrow new Error("sin firma");',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.response, null);
    assert.match(response.body.error, /script previo falló.*Error: sin firma \(línea 2\)/);
    assert.deepEqual(response.body.scripts.pre.logs, [{ level: "log", text: "voy" }]);
    assert.equal(hits, before);
  });

  test("un script que guarda `token` captura la sesión", async () => {
    const response = await send({
      environmentId,
      method: "GET",
      path: "/items/1",
      auth: { mode: "none" },
      postResponseScript: 'pm.environment.set("token", "tok-" + pm.response.code);',
    });
    assert.equal(response.body.sessionToken, "script");
    const stored = await api().get(`${base()}/session-token`).set(as(owner));
    assert.equal(stored.body.token.source, "script");
    assert.equal(stored.body.token.claims, null);
    const me = await send({ environmentId, method: "GET", path: "/me" });
    assert.equal(JSON.parse(me.body.response.body).headers.authorization, "Bearer tok-200");
    await api().delete(`${base()}/session-token`).set(as(owner));
  });
});
