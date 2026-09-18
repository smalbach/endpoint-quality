/**
 * Los canales Socket.IO por HTTP, contra un servidor `socket.io` en proceso: crear, conectar, oír
 * eventos, emitir con acuse, el espacio de nombres, el rechazo de la carga de `auth`, la inactividad,
 * la guarda de red, el nodo de un flujo — y que ni la carga de `auth` ni un secreto del entorno salen
 * por ninguna respuesta de la API ni quedan guardados, aunque el servidor los devuelva.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { startSocketIo, type TestSocketIo } from "../support/socketio-server";
import { STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
let server: TestSocketIo;
let open: TestSocketIo;
const api = () => request(context.app.getHttpServer());

const TOKEN = "tk-socketio-no-debe-salir-72c4";
const LITERAL = "literal-no-debe-guardarse-5e1b";

type Actor = { organizationId: string; token: string };
let owner: Actor;
let base: string;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

type Message = { direction: string; body: string; event?: string; ack?: boolean };
type SessionBody = {
  id: string;
  status: string;
  stopReason: string | null;
  verdict: { ok: boolean; failure: string | null; assertions: { label: string; pass: boolean; detail: string }[] };
  messages: Message[];
};

async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}

async function environment(): Promise<string> {
  const created = await api()
    .post(`${base}/environments`)
    .set(as(owner))
    .send({
      name: `sio-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "https://api.example.test",
      writesAllowed: true,
      authEnforced: false,
      variables: {
        sio: { initial: server.url },
        token: { initial: TOKEN, sensitive: true },
      },
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.environmentId as string;
}

async function channel(over: Record<string, unknown> = {}): Promise<string> {
  const created = await api()
    .post(`${base}/channels`)
    .set(as(owner))
    .send({
      protocol: "socketio",
      name: `sio-${Math.random().toString(36).slice(2, 8)}`,
      url: "{{sio}}",
      socketio: { auth: '{"token":"{{token}}"}' },
      ...over,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id as string;
}

async function read(sessionId: string): Promise<SessionBody> {
  return (await api().get(`${base}/channels/sessions/${sessionId}`).set(as(owner))).body as SessionBody;
}

async function waitFor(sessionId: string, done: (body: SessionBody) => boolean): Promise<SessionBody> {
  let body = await read(sessionId);
  for (let attempt = 0; attempt < 120 && !done(body); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    body = await read(sessionId);
  }
  return body;
}

/** Todo lo que los canales guardaron, como texto: donde no puede aparecer un secreto. */
const everythingStored = () =>
  JSON.stringify([
    [...context.repositories.channels.rows.values()],
    [...context.repositories.channelSessions.rows.values()],
    [...context.repositories.channelSessions.messages.values()],
  ]);

before(async () => {
  context = await createTestApp();
  server = await startSocketIo({ token: TOKEN });
  open = await startSocketIo();
  owner = await signUp(`sio-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "SIO" });
  base = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
  // Una corrida pide un contrato importado, aunque el flujo solo tenga canales.
  const imported = await api()
    .post(`${base}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
});

after(async () => {
  await context.close();
  await server.close();
  await open.close();
});

describe("un canal Socket.IO", () => {
  test("se crea con sus ajustes, sin literales de credencial, y lo que no es suyo es un 422", async () => {
    const id = await channel({
      socketio: {
        auth: `{"token":"${LITERAL}","sala":"general","clave":"{{token}}"}`,
        query: [{ name: "api_key", value: LITERAL, enabled: true }],
        events: ["chat"],
        listenAll: false,
      },
    });
    const got = await api().get(`${base}/channels/${id}`).set(as(owner));
    assert.equal(got.body.protocol, "socketio");
    assert.equal(got.body.socketio.path, "/socket.io");
    assert.deepEqual(got.body.socketio.transports, ["websocket"]);
    assert.deepEqual(JSON.parse(got.body.socketio.auth), { token: "", sala: "general", clave: "{{token}}" });
    assert.equal(got.body.socketio.query[0].value, "");
    assert.ok(!everythingStored().includes(LITERAL), "un literal de credencial no se guarda");

    const broken = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({
        protocol: "socketio",
        name: "roto",
        url: "mqtt://broker.example.test",
        subprotocols: ["chat"],
        expectations: { closeCode: 1000 },
        messages: [{ name: "x", body: "y", event: "connect" }],
        socketio: { version: 2, path: "socket.io", auth: "[1]", transports: [], events: ["disconnect"] },
      });
    assert.equal(broken.status, 422);
    const fields = broken.body.errors.map((error: { field: string }) => error.field).sort();
    assert.deepEqual(fields, [
      "expectations.closeCode",
      "messages.0.event",
      "socketio.auth",
      "socketio.events.0",
      "socketio.path",
      "socketio.transports",
      "socketio.version",
      "subprotocols",
      "url",
    ]);

    const wsWithEvent = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({ name: "ws", url: "wss://x.example.test", messages: [{ name: "a", body: "b", event: "chat" }] });
    assert.equal(wsWithEvent.status, 422);
  });

  test("conecta, oye los eventos con su nombre, emite, recibe el acuse y lo comprueba por evento", async () => {
    const environmentId = await environment();
    const id = await channel({
      expectations: {
        minMessages: 3,
        checks: [
          { source: "message", path: "total", operator: "equals", value: 5, match: { at: "last", event: "sumar" } },
          {
            source: "message",
            path: "hola",
            operator: "equals",
            value: "mundo",
            match: { at: "first", event: "bienvenida" },
          },
        ],
      },
    });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
    const session = `${base}/channels/sessions/${opened.body.id}`;

    const eco = await api()
      .post(`${session}/messages`)
      .set(as(owner))
      .send({ text: "", event: "eco", args: ['{"n":1}', "texto"] });
    assert.equal(eco.status, 202, JSON.stringify(eco.body));
    const sum = await api()
      .post(`${session}/messages`)
      .set(as(owner))
      .send({ text: '{"a":2,"b":3}', event: "sumar", ack: true });
    assert.equal(sum.status, 202, JSON.stringify(sum.body));

    const withoutEvent = await api().post(`${session}/messages`).set(as(owner)).send({ text: "hola" });
    assert.equal(withoutEvent.status, 422);
    assert.equal(withoutEvent.body.errors[0].field, "event");

    const body = await waitFor(opened.body.id, (current) => current.messages.some((message) => message.ack));
    // El saludo va primero, con la apertura; lo demás llega en el orden que el servidor contesta.
    const traffic = body.messages.filter((message) => message.direction === "in" || message.direction === "out");
    assert.deepEqual([traffic[0]!.direction, traffic[0]!.event], ["in", "bienvenida"]);
    assert.deepEqual(
      traffic.map((message) => `${message.direction} ${message.event}${message.ack ? " (acuse)" : ""}`).sort(),
      ["in bienvenida", "in eco", "in sumar (acuse)", "out eco", "out sumar (acuse)"],
    );
    const echoed = body.messages.find((message) => message.direction === "in" && message.event === "eco")!;
    assert.deepEqual(JSON.parse(echoed.body), [{ n: 1 }, "texto"]);
    const acked = body.messages.find((message) => message.ack && message.direction === "in")!;
    assert.deepEqual(JSON.parse(acked.body), { total: 5 });
    assert.ok(body.messages.some((message) => message.direction === "event" && message.event === "connect"));

    const closed = await api().post(`${session}/close`).set(as(owner));
    assert.equal(closed.body.verdict.ok, true, JSON.stringify(closed.body.verdict));
  });

  test("otro espacio de nombres, por su campo o por la ruta de la URL", async () => {
    const environmentId = await environment();
    for (const over of [
      { socketio: { namespace: "/admin", auth: "" } },
      { url: "{{sio}}/admin", socketio: { auth: "" } },
    ]) {
      const id = await channel({ ...over, expectations: { minMessages: 1 } });
      const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
      assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
      const body = await waitFor(opened.body.id, (current) => current.messages.some((m) => m.direction === "in"));
      const first = body.messages.find((message) => message.direction === "in")!;
      assert.equal(first.event, "admin");
      assert.deepEqual(JSON.parse(first.body), { ok: true });
      await api().post(`${base}/channels/sessions/${opened.body.id}/close`).set(as(owner));
    }
  });

  test("una carga de auth que el servidor rechaza es un rojo con su motivo y el connect_error anotado", async () => {
    const environmentId = await environment();
    const id = await channel({ socketio: { auth: '{"token":"{{falso}}"}' } });
    const missing = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(missing.status, 422, "una variable sin valor se dice antes de conectar");

    const wrong = await channel({ socketio: { auth: '{"token":"otro-{{token}}"}' } });
    const opened = await api().post(`${base}/channels/${wrong}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const body = await waitFor(opened.body.id, (current) => current.status !== "connecting");
    assert.equal(body.status, "error");
    assert.equal(body.verdict.failure, "network");
    assert.match(body.verdict.assertions[0]!.detail, /no autorizado/);
    const rejected = body.messages.find((message) => message.event === "connect_error")!;
    assert.match(rejected.body, /no autorizado.*codigo/);
    assert.ok(!JSON.stringify(body).includes(TOKEN));
  });

  test("un evento mayor que el tope no entra: la biblioteca corta la conexión antes de leerlo", async () => {
    const environmentId = await environment();
    const id = await channel({ limits: { maxMessageBytes: 1024 } });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
    await api()
      .post(`${base}/channels/sessions/${opened.body.id}/messages`)
      .set(as(owner))
      .send({ text: "", event: "grande", args: ['{"n":1}'] });
    const small = await waitFor(opened.body.id, (current) =>
      current.messages.some((m) => m.direction === "in" && m.event === "grande"),
    );
    assert.ok(small.messages.some((message) => message.direction === "in" && message.event === "grande"));
    // Ahora uno de 64 KB, con el tope del canal en 1 KB.
    await api()
      .post(`${base}/channels/sessions/${opened.body.id}/messages`)
      .set(as(owner))
      .send({ text: "", event: "grande", args: ['{"n":65536}'] });
    const body = await waitFor(opened.body.id, (current) => current.status !== "open");
    assert.equal(body.status, "closed", JSON.stringify(body));
    const received = body.messages.filter((message) => message.direction === "in" && message.event === "grande");
    assert.equal(received.length, 1, "el mensaje grande no llegó a la transcripción");
    assert.ok(body.messages.some((message) => message.event === "disconnect"));
  });

  test("un servidor que acepta y calla se corta por inactividad", async () => {
    const environmentId = await environment();
    const id = await channel({ socketio: { namespace: "/mudo", auth: "" }, limits: { idleMs: 150 } });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
    const body = await waitFor(opened.body.id, (current) => current.status !== "open");
    assert.equal(body.status, "closed", JSON.stringify(body));
    assert.equal(body.stopReason, "idle-cap");
  });

  test("por sondeo largo, sin upgrade: la query, las cabeceras y la carga llegan, y los secretos no se guardan", async () => {
    const environmentId = await environment();
    const id = await channel({
      headers: [{ name: "X-Api-Key", value: "{{token}}", enabled: true }],
      socketio: {
        transports: ["polling"],
        query: [{ name: "sala", value: "general", enabled: true }],
        auth: '{"token":"{{token}}"}',
      },
    });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
    const session = `${base}/channels/sessions/${opened.body.id}`;
    const sent = await api()
      .post(`${session}/messages`)
      .set(as(owner))
      .send({ text: '{"clave":"{{token}}","n":7}', event: "eco" });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const body = await waitFor(opened.body.id, (current) =>
      current.messages.some((message) => message.direction === "in" && message.event === "eco"),
    );
    const handshake = server.handshakes.at(-1)!;
    assert.equal(handshake.query.sala, "general");
    assert.equal(handshake.query.transport, "polling");
    assert.equal(handshake.headers["x-api-key"], TOKEN);
    // El servidor devuelve el token en el saludo y en el eco: tapado en los dos, y en la respuesta.
    const welcome = body.messages.find((message) => message.event === "bienvenida")!;
    assert.equal(JSON.parse(welcome.body).recibido, "••••••••");
    const echoed = body.messages.find((message) => message.direction === "in" && message.event === "eco")!;
    assert.equal(JSON.parse(echoed.body).n, 7);
    await api().post(`${session}/close`).set(as(owner));
    assert.ok(!JSON.stringify(body).includes(TOKEN), "la respuesta de la API no lleva el token");
    assert.ok(!everythingStored().includes(TOKEN), "nada guardado lleva el token");
  });
});

describe("un nodo canal Socket.IO", () => {
  test("emite por guion con acuse, captura sin tapar y guarda tapado", async () => {
    const environmentId = await environment();
    const id = await channel({
      expectations: {
        checks: [
          { source: "message", path: "total", operator: "equals", value: 9, match: { at: "any", event: "sumar" } },
        ],
      },
    });
    const flow = await api()
      .post(`${base}/workflows`)
      .set(as(owner))
      .send({
        name: "sio",
        definition: {
          steps: [
            {
              id: "sio",
              kind: "channel",
              channel: {
                channelId: id,
                untilMessages: 2,
                messages: [{ action: "send", event: "sumar", ack: true, body: '{"a":4,"b":5,"t":"{{token}}"}' }],
              },
              captures: [{ variable: "total", from: "body", path: "last.total" }],
            },
            {
              id: "leer",
              kind: "mock",
              dependsOn: ["sio"],
              mock: { status: 200, body: '{"total":"{{total}}"}' },
              checks: [{ source: "body", path: "total", operator: "equals", value: "9" }],
            },
          ],
        },
      });
    assert.equal(flow.status, 201, JSON.stringify(flow.body));
    const started = await api()
      .post(`${base}/runs`)
      .set(as(owner))
      .send({ environmentId, workflowId: flow.body.workflowId });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await context.queue.idle();
    const run = await api().get(`${base}/runs/${started.body.runId}`).set(as(owner));
    const cases = run.body.cases as { id: string; scenarioId: string; status: string; method: string }[];
    const sio = cases.find((item) => item.scenarioId.endsWith(":sio"))!;
    const detail = await api().get(`${base}/runs/${started.body.runId}/cases/${sio.id}`).set(as(owner));
    assert.equal(sio.status, "passed", JSON.stringify(detail.body.steps?.[0]?.assertions));
    assert.equal(sio.method, "SOCKETIO");
    assert.equal(cases.find((item) => item.scenarioId.endsWith(":leer"))!.status, "passed");

    const withoutEvent = await api()
      .post(`${base}/workflows`)
      .set(as(owner))
      .send({
        name: "sio sin evento",
        definition: {
          steps: [
            { id: "sio", kind: "channel", channel: { channelId: id, messages: [{ action: "send", body: "x" }] } },
          ],
        },
      });
    const refused = await api()
      .post(`${base}/runs`)
      .set(as(owner))
      .send({ environmentId, workflowId: withoutEvent.body.workflowId });
    await context.queue.idle();
    const refusedRun = await api().get(`${base}/runs/${refused.body.runId}`).set(as(owner));
    assert.equal(refusedRun.body.cases[0].failure, "config");
    assert.ok(!everythingStored().includes(TOKEN));
    assert.ok(
      ![...context.repositories.runs.steps.values(), ...context.repositories.runs.cases.values()].some((row) =>
        JSON.stringify(row).includes(TOKEN),
      ),
    );
  });
});

describe("con la guarda de red de producción", () => {
  test("un servidor Socket.IO en loopback no se abre: rojo de configuración con el motivo", async () => {
    const guarded = await createTestApp({ channelPrivateTargets: false });
    const guardedApi = () => request(guarded.app.getHttpServer());
    try {
      const password = "Una-contraseña-larga-1";
      const email = `guarda-sio-${Date.now()}@example.test`;
      const registered = await guardedApi().post("/auth/register").send({ email, password, name: "x" });
      const login = await guardedApi().post("/auth/login").send({ email, password });
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };
      const project = await guardedApi()
        .post(`/orgs/${registered.body.organizationId}/projects`)
        .set(auth)
        .send({ name: "Guarda" });
      const guardedBase = `/orgs/${registered.body.organizationId}/projects/${project.body.projectId}`;
      for (const [url, transports] of [
        [open.url, ["websocket"]],
        [`http://[::ffff:127.0.0.1]:${open.port}`, ["polling"]],
      ] as const) {
        const created = await guardedApi()
          .post(`${guardedBase}/channels`)
          .set(auth)
          .send({ protocol: "socketio", name: `interno-${transports[0]}`, url, socketio: { transports } });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const before = open.handshakes.length;
        const opened = await guardedApi()
          .post(`${guardedBase}/channels/${created.body.id}/sessions`)
          .set(auth)
          .send({});
        assert.equal(opened.body.status, "error", JSON.stringify(opened.body));
        assert.equal(opened.body.verdict.failure, "config");
        assert.match(opened.body.verdict.assertions[0].detail, /loopback|privad/i);
        assert.equal(open.handshakes.length, before, "el servidor no llegó a ver nada");
      }
    } finally {
      await guarded.close();
    }
  });
});
