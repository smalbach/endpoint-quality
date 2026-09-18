/**
 * Capturar tráfico, por HTTP: abrir una sesión, usar el proxy de verdad, parar e importar.
 *
 * Lo que estas pruebas añaden a las del proxy suelto: que el token sale **una vez** y ninguna
 * lectura lo repite, que el proxy de la aplicación lee la política de red del despliegue (aquí
 * cerrada: loopback no se alcanza), que parar invalida el token, que lo grabado no sale de otro
 * proyecto, y que importar pasa por la puerta del HAR —endpoints, ejemplos y el resumen de siempre—.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import request from "supertest";

import { captureItemFrom, type RawExchange } from "@/modules/captures/domain/model";
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

let owner: Actor;
let projectId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

function viaProxy(port: number, url: string, token: string | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = token
      ? { "Proxy-Authorization": `Basic ${Buffer.from(`captura:${token}`).toString("base64")}` }
      : {};
    const req = httpRequest({ host: "127.0.0.1", port, path: url, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

let seq = 0;
async function seed(sessionId: string, patch: Partial<RawExchange> & { url: string }) {
  seq += 1;
  const item = captureItemFrom(
    {
      at: new Date("2026-03-01T10:00:00Z"),
      method: "GET",
      status: 200,
      encrypted: false,
      requestHeaders: {},
      requestBody: Buffer.alloc(0),
      requestBodyTruncated: false,
      responseHeaders: { "content-type": "application/json" },
      responseBody: Buffer.from('{"ok":true}'),
      responseBodyTruncated: false,
      durationMs: 4,
      error: null,
      ...patch,
    },
    { sessionId, projectId, seq },
  );
  await context.repositories.captures.appendItem(item);
  return item;
}

before(async () => {
  context = await createTestApp();
  owner = await signUp(`captures-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Captura" });
  assert.equal(project.status, 201);
  projectId = project.body.projectId;
});

after(async () => {
  await context.close();
});

describe("capturar tráfico", () => {
  test("abrir da el token una vez; el proxy lo pide, aplica la guarda de red, y parar lo invalida", async () => {
    const overview = await api().get(`${base()}/captures`).set(as(owner));
    assert.equal(overview.status, 200);
    assert.equal(overview.body.enabled, true);

    const started = await api().post(`${base()}/captures`).set(as(owner));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const { token, session, proxy } = started.body as {
      token: string;
      session: { id: string; status: string };
      proxy: { port: number; username: string };
    };
    assert.equal(session.status, "active");
    assert.ok(token.length >= 40);
    assert.equal(proxy.username, "captura");
    assert.ok(proxy.port > 0);

    // Ninguna lectura vuelve a enseñar el token, ni se guarda en claro.
    const again = await api().get(`${base()}/captures`).set(as(owner));
    assert.ok(!JSON.stringify(again.body).includes(token));
    assert.ok(!JSON.stringify([...context.repositories.captures.sessions.values()]).includes(token));

    assert.equal((await viaProxy(proxy.port, "http://127.0.0.1:9/x", null)).status, 407);
    // La política de la aplicación de prueba es la del despliegue por omisión: red privada cerrada.
    const blocked = await viaProxy(proxy.port, "http://127.0.0.1:9/x", token);
    assert.equal(blocked.status, 403);
    assert.match(blocked.body, /loopback/);

    const stopped = await api().post(`${base()}/captures/${session.id}/stop`).set(as(owner));
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.status, "stopped");
    assert.equal(stopped.body.stopReason, "manual");
    assert.equal(stopped.body.itemCount, 1);

    const page = await api().get(`${base()}/captures/${session.id}?after=0`).set(as(owner));
    assert.equal(page.body.items.length, 1);
    assert.ok(page.body.items[0].error);
    // Sin sesiones abiertas, el puerto ya no escucha.
    await assert.rejects(viaProxy(proxy.port, "http://127.0.0.1:9/x", token));
  });

  test("abrir otra cierra la anterior", async () => {
    const first = await api().post(`${base()}/captures`).set(as(owner));
    const second = await api().post(`${base()}/captures`).set(as(owner));
    assert.equal(second.status, 201);
    const overview = await api().get(`${base()}/captures`).set(as(owner));
    const previous = overview.body.sessions.find((entry: { id: string }) => entry.id === first.body.session.id);
    assert.equal(previous.stopReason, "replaced");
    await api().post(`${base()}/captures/${second.body.session.id}/stop`).set(as(owner));
  });

  test("lo elegido se importa por la puerta del HAR, y un túnel se dice", async () => {
    const started = await api().post(`${base()}/captures`).set(as(owner));
    const sessionId: string = started.body.session.id;
    const list = await seed(sessionId, {
      url: "https://api.ejemplo.com/v1/pedidos?page=1",
      requestHeaders: { Authorization: "Bearer TOKEN-CAPTURADO" },
      responseBody: Buffer.from('{"items":[],"access_token":"OTRO-SECRETO"}'),
    });
    const notFound = await seed(sessionId, { url: "https://api.ejemplo.com/v1/pedidos?page=9", status: 404 });
    const bundle = await seed(sessionId, {
      url: "https://app.ejemplo.com/main.js",
      responseHeaders: { "content-type": "text/javascript" },
    });
    const tunnel = await seed(sessionId, {
      url: "https://api.ejemplo.com:443",
      method: "CONNECT",
      encrypted: true,
      status: null,
    });

    const page = await api().get(`${base()}/captures/${sessionId}?after=0`).set(as(owner));
    assert.equal(page.body.items.length, 4);
    assert.match(page.body.items[2].noise, /recursos de la página/);
    const detail = await api().get(`${base()}/captures/${sessionId}/items/${list.id}`).set(as(owner));
    assert.equal(detail.body.requestHeaders.Authorization, "Bearer ••••••••");

    const imported = await api()
      .post(`${base()}/captures/${sessionId}/import`)
      .set(as(owner))
      .send({ itemIds: [list.id, notFound.id, bundle.id, tunnel.id], flow: true });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const [item] = imported.body.items;
    assert.equal(item.kind, "har");
    const endpoints = item.results.find((entry: { target: string }) => entry.target === "endpoints");
    assert.equal(endpoints.error, null);
    assert.deepEqual(
      endpoints.endpoints.map((entry: { method: string; path: string }) => `${entry.method} ${entry.path}`),
      ["GET /v1/pedidos"],
    );
    assert.ok(endpoints.notes.some((note: string) => /túnel HTTPS/.test(note)));
    const flows = item.results.find((entry: { target: string }) => entry.target === "flows");
    assert.equal(flows.error, null, JSON.stringify(flows));

    const endpointId: string = endpoints.endpoints[0].id;
    const examples = [...context.repositories.examples.rows.values()].filter((row) => row.endpointId === endpointId);
    assert.deepEqual(examples.map((row) => row.response.status).sort(), [200, 404]);

    // Ni el token de la cabecera ni el del cuerpo llegan a ninguna tabla.
    const everything = JSON.stringify([
      [...context.repositories.captures.items.values()],
      [...context.repositories.endpoints.rows.values()],
      [...context.repositories.examples.rows.values()],
    ]);
    assert.ok(!everything.includes("TOKEN-CAPTURADO"));
    assert.ok(!everything.includes("OTRO-SECRETO"));
    await api().post(`${base()}/captures/${sessionId}/stop`).set(as(owner));
  });

  test("solo túneles no se importan, con el motivo", async () => {
    const started = await api().post(`${base()}/captures`).set(as(owner));
    const sessionId: string = started.body.session.id;
    const tunnel = await seed(sessionId, {
      url: "https://a.test:443",
      method: "CONNECT",
      encrypted: true,
      status: null,
    });
    const refused = await api()
      .post(`${base()}/captures/${sessionId}/import`)
      .set(as(owner))
      .send({ itemIds: [tunnel.id] });
    assert.equal(refused.status, 422);
    await api().delete(`${base()}/captures/${sessionId}`).set(as(owner)).expect(204);
    assert.equal(
      [...context.repositories.captures.items.values()].some((row) => row.sessionId === sessionId),
      false,
    );
  });

  test("otro proyecto no alcanza la captura, ni por la sesión ni por la petición", async () => {
    const started = await api().post(`${base()}/captures`).set(as(owner));
    const sessionId: string = started.body.session.id;
    const item = await seed(sessionId, { url: "https://api.test/x" });
    const other = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Otro" });
    const elsewhere = `/orgs/${owner.organizationId}/projects/${other.body.projectId}/captures/${sessionId}`;
    assert.equal((await api().get(`${elsewhere}?after=0`).set(as(owner))).status, 404);
    assert.equal((await api().get(`${elsewhere}/items/${item.id}`).set(as(owner))).status, 404);
    assert.equal((await api().post(`${elsewhere}/stop`).set(as(owner))).status, 404);

    const stranger = await signUp(`captures-otro-${Date.now()}@example.test`);
    assert.equal((await api().get(`${base()}/captures/${sessionId}?after=0`).set(as(stranger))).status, 403);
    await api().post(`${base()}/captures/${sessionId}/stop`).set(as(owner));
  });
});

describe("descifrar HTTPS, por HTTP", () => {
  test("apagado: la vista no lo ofrece, y pedirlo al abrir es un 409 con el motivo", async () => {
    const overview = await api().get(`${base()}/captures`).set(as(owner));
    assert.equal(overview.body.mitm, null);
    const refused = await api().post(`${base()}/captures`).set(as(owner)).send({ decryptHttps: true });
    assert.equal(refused.status, 409);
    assert.match(JSON.stringify(refused.body), /CAPTURE_MITM/);
    assert.equal((await api().get(`${base()}/captures/authority/certificate`).set(as(owner))).status, 409);
  });

  test("encendido: la CA se descarga sin la clave, y la sesión sale marcada", async () => {
    const mitm = await createTestApp({ env: { CAPTURE_MITM: "true" } });
    try {
      const http = () => request(mitm.app.getHttpServer());
      const password = "Una-contraseña-larga-1";
      const email = `captures-mitm-${Date.now()}@example.test`;
      const registered = await http().post("/auth/register").send({ email, password, name: "x" });
      const login = await http().post("/auth/login").send({ email, password });
      const headers = { Authorization: `Bearer ${login.body.accessToken}` };
      const organizationId: string = registered.body.organizationId;
      const project = await http().post(`/orgs/${organizationId}/projects`).set(headers).send({ name: "MITM" });
      const root = `/orgs/${organizationId}/projects/${project.body.projectId}/captures`;

      const overview = await http().get(root).set(headers);
      assert.deepEqual(overview.body.mitm, { ready: true, problem: null });

      const authority = await http().get(`${root}/authority/certificate`).set(headers);
      assert.equal(authority.status, 200);
      assert.match(authority.body.pem, /BEGIN CERTIFICATE/);
      assert.ok(!JSON.stringify(authority.body).includes("PRIVATE KEY"));
      // En la tabla, la clave solo cifrada.
      const row = mitm.repositories.captureAuthorities.row!;
      assert.ok(row.privateKeyCiphertext.startsWith("v1."));
      assert.ok(!JSON.stringify(row).includes("PRIVATE KEY"));

      const started = await http().post(root).set(headers).send({ decryptHttps: true });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.equal(started.body.session.decryptHttps, true);
      await http().post(`${root}/${started.body.session.id}/stop`).set(headers);
    } finally {
      await mitm.close();
    }
  });
});
