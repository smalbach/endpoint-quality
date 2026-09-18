/**
 * Los canales por HTTP: crear, abrir, conversar, cerrar — y lo que no puede pasar por el camino.
 *
 * Contra el transporte guionizado de la aplicación de prueba, que entrega el saludo en el mismo tic
 * que la apertura como un servidor de verdad. Lo que aquí se fija y en ningún otro sitio:
 *
 * - que un secreto del entorno **no sale por ninguna respuesta** de la API —ni en la sesión, ni en
 *   sus mensajes, ni en el canal—, y que el socket sí lo recibió, porque taparlo al mandar sería no
 *   mandar la credencial;
 * - que un entorno sin escrituras deja escuchar y no deja mandar, que es la misma protección que un
 *   `POST` contra producción, adaptada a lo que un socket es;
 * - y los permisos: leer es `viewer`, todo lo demás es `editor`, y otro proyecto es un 403.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocketServer } from "ws";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string; userId: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return {
    organizationId: registered.body.organizationId,
    userId: registered.body.userId,
    token: session.body.accessToken,
  };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

const SOCKET = "wss://eco.example.test/socket";
const TOKEN = "tk-canal-no-debe-salir-7c1d";

let owner: Actor;
let outsider: Actor;
let base: string;

async function environment(writesAllowed: boolean): Promise<string> {
  const created = await api()
    .post(`${base}/environments`)
    .set(as(owner))
    .send({
      name: `entorno-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "https://api.example.test",
      writesAllowed,
      authEnforced: false,
      variables: { wsBase: { initial: "wss://eco.example.test" }, token: { initial: TOKEN, sensitive: true } },
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.environmentId as string;
}

async function channel(over: Record<string, unknown> = {}): Promise<string> {
  const created = await api()
    .post(`${base}/channels`)
    .set(as(owner))
    .send({ name: `eco-${Math.random().toString(36).slice(2, 8)}`, url: "{{wsBase}}/socket", ...over });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id as string;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

before(async () => {
  context = await createTestApp();
  owner = await signUp(`canales-${Date.now()}@example.test`);
  outsider = await signUp(`canales-fuera-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Canales" });
  assert.equal(project.status, 201);
  base = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
});

after(async () => {
  await context.close();
});

beforeEach(() => context.channels.reset());

describe("el canal", () => {
  test("se crea, se lee, se cambia y se borra en blando", async () => {
    const id = await channel({ subprotocols: ["eq.v1"], expectations: { minMessages: 1 } });
    const read = await api().get(`${base}/channels/${id}`).set(as(owner));
    assert.equal(read.status, 200);
    assert.equal(read.body.protocol, "ws");
    assert.deepEqual(read.body.subprotocols, ["eq.v1"]);
    assert.deepEqual(read.body.sessions, []);

    const changed = await api()
      .patch(`${base}/channels/${id}`)
      .set(as(owner))
      .send({ limits: { idleMs: 2_000 } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.limits.idleMs, 2_000);

    assert.equal((await api().delete(`${base}/channels/${id}`).set(as(owner))).status, 204);
    assert.equal((await api().get(`${base}/channels/${id}`).set(as(owner))).status, 404);
    const list = await api().get(`${base}/channels`).set(as(owner));
    assert.ok(!list.body.channels.some((row: { id: string }) => row.id === id));
  });

  test("lo que nunca podrá funcionar es un 422 con el campo", async () => {
    const response = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({
        name: "roto",
        url: "https://api.example.test/chat",
        headers: [{ name: "Sec-WebSocket-Key", value: "x", enabled: true }],
        expectations: { checks: [{ source: "status", operator: "equals", value: 200 }] },
        limits: { maxDurationMs: 3_600_000 },
      });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.deepEqual(response.body.errors.map((problem: { field: string }) => problem.field).sort(), [
      "expectations.checks.0.source",
      "headers.0.name",
      "limits.maxDurationMs",
      "url",
    ]);
  });

  test("otro proyecto es un 403, y quien lee no crea", async () => {
    assert.equal((await api().get(`${base}/channels`).set(as(outsider))).status, 403);
    assert.equal((await api().post(`${base}/channels`).set(as(outsider)).send({ name: "x", url: SOCKET })).status, 403);
  });
});

describe("una sesión", () => {
  test("abre contra el entorno, conversa, y ningún secreto sale por la API", async () => {
    const environmentId = await environment(true);
    const id = await channel({ auth: { type: "bearer", params: { token: "{{token}}" } } });
    context.channels.script(SOCKET, {
      greeting: [`{"type":"welcome","session":"${TOKEN}"}`],
      reply: (text) => [`{"type":"eco","got":${JSON.stringify(text)}}`],
    });

    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.status, "open");
    assert.equal(opened.body.live, true);

    const sent = await api()
      .post(`${base}/channels/sessions/${opened.body.id}/messages`)
      .set(as(owner))
      .send({ text: `{"type":"auth","token":"${TOKEN}"}` });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settle();

    const read = await api().get(`${base}/channels/sessions/${opened.body.id}`).set(as(owner));
    assert.equal(read.status, 200);
    assert.deepEqual(
      read.body.messages.map((message: { direction: string }) => message.direction),
      ["in", "out", "in"],
    );

    // La regla entera en una línea: el valor no está en **nada** de lo que la API contesta.
    const everything = JSON.stringify([
      opened.body,
      read.body,
      (await api().get(`${base}/channels/${id}`).set(as(owner))).body,
    ]);
    assert.ok(!everything.includes(TOKEN), everything);
    // Y el socket sí lo recibió, en la cabecera firmada y en el mensaje: tapar lo que se manda sería
    // no mandar la credencial.
    assert.equal(context.channels.opened[0].options.headers?.Authorization, `Bearer ${TOKEN}`);
    assert.ok(context.channels.sent[0].text.includes(TOKEN));
  });

  test("un entorno sin escrituras deja escuchar y no deja mandar", async () => {
    const environmentId = await environment(false);
    const id = await channel();
    context.channels.script(SOCKET, { greeting: ["hola"] });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "open");
    const sent = await api()
      .post(`${base}/channels/sessions/${opened.body.id}/messages`)
      .set(as(owner))
      .send({ text: "borra todo" });
    assert.equal(sent.status, 409, JSON.stringify(sent.body));
    assert.match(String(sent.body.type), /writes-not-allowed$/);
    assert.equal(context.channels.sent.length, 0, "no puede haber salido nada");
    await api().post(`${base}/channels/sessions/${opened.body.id}/close`).set(as(owner));
  });

  test("una variable sin valor se dice antes de conectar, con su nombre", async () => {
    const id = await channel();
    const response = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({});
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.match(response.body.errors[0].detail, /\{\{wsBase\}\} no tiene valor: elige un entorno/);
    assert.equal(context.channels.opened.length, 0);
  });

  test("un upgrade rechazado deja la sesión en rojo con el número, y no es un error de la API", async () => {
    const environmentId = await environment(true);
    const id = await channel({ expectations: { minMessages: 1 } });
    context.channels.script(SOCKET, { rejectWith: 403 });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.status, "error");
    assert.equal(opened.body.verdict.failure, "network");
    assert.match(opened.body.verdict.assertions[0].detail, /403/);
  });

  test("cerrar deja el veredicto, y una cerrada ya no acepta mensajes", async () => {
    const environmentId = await environment(true);
    const id = await channel({
      expectations: {
        minMessages: 1,
        checks: [{ source: "message", path: "type", operator: "equals", value: "welcome", match: { at: "first" } }],
      },
    });
    context.channels.script(SOCKET, { greeting: ['{"type":"welcome"}'] });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    await settle();

    const closed = await api().post(`${base}/channels/sessions/${opened.body.id}/close`).set(as(owner));
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.status, "closed");
    assert.equal(closed.body.stopReason, "closed-by-us");
    assert.equal(closed.body.verdict.ok, true, JSON.stringify(closed.body.verdict));
    assert.deepEqual(context.channels.closed, [{ url: SOCKET, code: 1000, reason: "closed-by-us" }]);

    const late = await api()
      .post(`${base}/channels/sessions/${opened.body.id}/messages`)
      .set(as(owner))
      .send({ text: "¿hola?" });
    assert.equal(late.status, 409);
    assert.match(String(late.body.type), /channel-session-finished$/);

    // Cerrar otra vez no es un error: lo que se pedía ya está.
    assert.equal((await api().post(`${base}/channels/sessions/${opened.body.id}/close`).set(as(owner))).status, 200);
  });

  test("el stream de una sesión terminada contesta con la transcripción y se cierra", async () => {
    const environmentId = await environment(true);
    const id = await channel();
    context.channels.script(SOCKET, { greeting: ["hola"], closeAfterGreeting: 1000 });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "closed");

    const stream = await api()
      .get(`${base}/channels/sessions/${opened.body.id}/stream`)
      .set(as(owner))
      .buffer(true)
      .parse((response, done) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () => done(null, text));
      });
    assert.equal(stream.status, 200);
    assert.match(String(stream.body), /event: finished/);
    assert.match(String(stream.body), /"stopReason":"closed-by-peer"/);
  });

  test("quien solo lee ve la sesión, pero no la abre ni le manda nada", async () => {
    // El `viewer` de verdad: una membresía con ese rol en la organización del proyecto.
    const reader = await signUp(`canales-lector-${Date.now()}@example.test`);
    await context.repositories.memberships.save({
      organizationId: owner.organizationId,
      userId: reader.userId,
      role: "viewer",
      createdAt: context.clock.now(),
    });
    const environmentId = await environment(true);
    const id = await channel();
    context.channels.script(SOCKET, { greeting: ["hola"] });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });

    assert.equal((await api().get(`${base}/channels/sessions/${opened.body.id}`).set(as(reader))).status, 200);
    assert.equal(
      (await api().post(`${base}/channels/${id}/sessions`).set(as(reader)).send({ environmentId })).status,
      403,
    );
    assert.equal(
      (await api().post(`${base}/channels/sessions/${opened.body.id}/messages`).set(as(reader)).send({ text: "x" }))
        .status,
      403,
    );
    await api().post(`${base}/channels/sessions/${opened.body.id}/close`).set(as(owner));
  });
});

describe("contra un servidor de verdad en loopback", () => {
  /**
   * La misma API, pero sin guion: la URL no está guionizada, así que el transporte de la aplicación
   * de prueba la manda al de verdad —`ws`, la guarda de red, `createConnection` contra la IP— y hay
   * bytes de verdad en el cable. Es lo que prueba que las piezas probadas por separado encajan: el
   * saludo que llega con el 101, el código de cierre de verdad y el reloj que corta un socket callado.
   */
  let server: Server;
  let sockets: WebSocketServer;
  let port: number;

  before(async () => {
    server = createServer();
    sockets = new WebSocketServer({ server });
    sockets.on("connection", (client, upgrade) => {
      if (upgrade.url === "/calla") return;
      client.send('{"type":"welcome"}');
      client.on("message", (data) => {
        const text = String(data);
        if (text === "adiós") client.close(4001, "hasta luego");
        else client.send(JSON.stringify({ type: "eco", got: text }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("saludo, eco y un cierre con código propio, con bytes de verdad", async () => {
    const id = await channel({
      url: `ws://127.0.0.1:${port}/eco`,
      expectations: {
        closeCode: 4001,
        checks: [{ source: "message", path: "type", operator: "equals", value: "eco", match: { at: "any" } }],
      },
    });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({});
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.handshake.status, 101);

    await api().post(`${base}/channels/sessions/${opened.body.id}/messages`).set(as(owner)).send({ text: "hola" });
    await settle();
    await api().post(`${base}/channels/sessions/${opened.body.id}/messages`).set(as(owner)).send({ text: "adiós" });

    // El cierre lo da el servidor: hay que esperar a que llegue, no a un tiempo fijo.
    let read = await api().get(`${base}/channels/sessions/${opened.body.id}`).set(as(owner));
    for (let attempt = 0; attempt < 50 && read.body.status === "open"; attempt += 1) {
      await settle();
      read = await api().get(`${base}/channels/sessions/${opened.body.id}`).set(as(owner));
    }
    assert.equal(read.body.status, "closed", JSON.stringify(read.body));
    assert.equal(read.body.stopReason, "closed-by-peer");
    assert.equal(read.body.closeCode, 4001);
    assert.equal(read.body.closeReason, "hasta luego");
    assert.deepEqual(
      read.body.messages.map((message: { direction: string; body: string }) => [message.direction, message.body]),
      [
        ["in", '{"type":"welcome"}'],
        ["out", "hola"],
        ["in", '{"type":"eco","got":"hola"}'],
        ["out", "adiós"],
      ],
    );
    assert.equal(read.body.verdict.ok, true, JSON.stringify(read.body.verdict));
  });

  test("un servidor que acepta y calla se corta por inactividad, con el reloj del registro", async () => {
    const id = await channel({ url: `ws://127.0.0.1:${port}/calla`, limits: { idleMs: 150 } });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({});
    assert.equal(opened.body.status, "open");

    let read = opened;
    for (let attempt = 0; attempt < 60 && read.body.status === "open"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      read = await api().get(`${base}/channels/sessions/${opened.body.id}`).set(as(owner));
    }
    assert.equal(read.body.status, "closed", JSON.stringify(read.body));
    assert.equal(read.body.stopReason, "idle-cap");
  });
});
