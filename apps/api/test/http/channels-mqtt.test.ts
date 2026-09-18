/**
 * Los canales MQTT por HTTP, contra un broker `aedes` en proceso: crear, conectar, suscribirse,
 * publicar, el veredicto — y que ni la contraseña del broker ni un secreto del entorno salen por
 * ninguna respuesta de la API, aunque el broker los devuelva dentro de un mensaje.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { BROKER_USER, startAedes, startMqtt5, type TestBroker } from "../support/mqtt-broker";

let context: TestContext;
let broker: TestBroker;
const api = () => request(context.app.getHttpServer());

const PASSWORD = "clave-broker-no-debe-salir-51af";
const TOKEN = "tk-entorno-no-debe-salir-0b7e";

type Actor = { organizationId: string; token: string };
let owner: Actor;
let base: string;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

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
      name: `mqtt-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "https://api.example.test",
      writesAllowed: true,
      authEnforced: false,
      variables: {
        broker: { initial: `mqtt://127.0.0.1:${broker.port}` },
        mqttPass: { initial: PASSWORD, sensitive: true },
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
      protocol: "mqtt",
      name: `broker-${Math.random().toString(36).slice(2, 8)}`,
      url: "{{broker}}",
      auth: { type: "basic", params: { username: BROKER_USER, password: "{{mqttPass}}" } },
      ...over,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id as string;
}

async function waitFor(sessionId: string, done: (body: { status: string; messages: unknown[] }) => boolean) {
  let read = await api().get(`${base}/channels/sessions/${sessionId}`).set(as(owner));
  for (let attempt = 0; attempt < 80 && !done(read.body); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    read = await api().get(`${base}/channels/sessions/${sessionId}`).set(as(owner));
  }
  return read;
}

before(async () => {
  context = await createTestApp();
  broker = await startAedes({ password: PASSWORD, forbidden: "prohibido/" });
  owner = await signUp(`mqtt-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "MQTT" });
  base = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
});

after(async () => {
  await context.close();
  await broker.close();
});

describe("un canal MQTT", () => {
  test("se crea con sus ajustes, y lo que no es de MQTT es un 422 con el campo", async () => {
    const id = await channel({ mqtt: { version: 5, subscriptions: [{ topic: "sensores/+/temp", qos: 1 }] } });
    const read = await api().get(`${base}/channels/${id}`).set(as(owner));
    assert.equal(read.body.protocol, "mqtt");
    assert.equal(read.body.mqtt.version, 5);
    assert.equal(read.body.mqtt.keepaliveSec, 60);
    assert.deepEqual(read.body.mqtt.subscriptions, [{ topic: "sensores/+/temp", qos: 1 }]);

    const broken = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({
        protocol: "mqtt",
        name: "roto",
        url: "https://broker.example.test",
        headers: [{ name: "X-A", value: "b", enabled: true }],
        auth: { type: "bearer", params: { token: "{{token}}" } },
        expectations: {
          closeCode: 1000,
          checks: [{ source: "message", operator: "exists", match: { at: "any", topic: "a/#/b" } }],
        },
        mqtt: { version: 3, keepaliveSec: -1, subscriptions: [{ topic: "sensores/#/x", qos: 3 }] },
      });
    assert.equal(broken.status, 422);
    const fields = broken.body.errors.map((error: { field: string }) => error.field).sort();
    assert.deepEqual(fields, [
      "auth.type",
      "expectations.checks.0.match.topic",
      "expectations.closeCode",
      "headers",
      "mqtt.keepaliveSec",
      "mqtt.subscriptions.0.qos",
      "mqtt.subscriptions.0.topic",
      "mqtt.version",
      "url",
    ]);

    // Un WebSocket no lleva ajustes de MQTT.
    const ws = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({ name: "ws", url: "wss://eco.example.test", mqtt: { version: 4 } });
    assert.equal(ws.status, 422);
  });

  test("una contraseña escrita a mano no se guarda; una {{variable}} sí", async () => {
    const literal = await channel({ auth: { type: "basic", params: { username: BROKER_USER, password: PASSWORD } } });
    const read = await api().get(`${base}/channels/${literal}`).set(as(owner));
    assert.equal(read.body.auth.params.password, "");
    assert.ok(!JSON.stringify(context.repositories.channels.rows.get(literal)).includes(PASSWORD));

    const variable = await channel();
    assert.equal(
      (await api().get(`${base}/channels/${variable}`).set(as(owner))).body.auth.params.password,
      "{{mqttPass}}",
    );
  });

  test("lo mismo en un WebSocket: el token literal de la autenticación se guarda vacío", async () => {
    const created = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({ name: "ws-literal", url: "wss://eco.example.test", auth: { type: "bearer", params: { token: TOKEN } } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.auth.params.token, "");
  });
});

describe("una sesión MQTT contra un broker de verdad", () => {
  test("conecta, recibe el retenido, publica, oye el eco con su tema, y ningún secreto sale por la API", async () => {
    const environmentId = await environment();
    await broker.publish("casa/sala/temp", '{"t":21}', true);
    const id = await channel({
      mqtt: { subscriptions: [{ topic: "casa/#", qos: 1 }] },
      expectations: {
        minMessages: 2,
        checks: [
          { source: "message", path: "t", operator: "equals", value: 21, match: { at: "first", topic: "casa/+/temp" } },
          { source: "messageCount", operator: "equals", value: 1, match: { at: "any", topic: "casa/eco" } },
        ],
      },
    });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
    assert.equal(opened.body.handshake.via, "CONNACK");
    assert.equal(opened.body.handshake.status, 0);

    // Sin tema no se publica.
    const bare = await api()
      .post(`${base}/channels/sessions/${opened.body.id}/messages`)
      .set(as(owner))
      .send({ text: "x" });
    assert.equal(bare.status, 422);

    const sent = await api()
      .post(`${base}/channels/sessions/${opened.body.id}/messages`)
      .set(as(owner))
      .send({ text: `{"clave":"${PASSWORD}","otra":"${TOKEN}"}`, topic: "casa/eco", qos: 1, retain: false });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));

    const read = await waitFor(opened.body.id, (body) => body.messages.length >= 3);
    const rows = read.body.messages as { direction: string; topic?: string; retain?: boolean; qos?: number }[];
    assert.deepEqual(
      rows.map((row) => [row.direction, row.topic]),
      [
        ["in", "casa/sala/temp"],
        ["out", "casa/eco"],
        ["in", "casa/eco"],
      ],
    );
    assert.equal(rows[0].retain, true);
    assert.equal(rows[1].qos, 1);

    const closed = await api().post(`${base}/channels/sessions/${opened.body.id}/close`).set(as(owner));
    assert.equal(closed.body.verdict.ok, true, JSON.stringify(closed.body.verdict));
    assert.match(closed.body.verdict.assertions[0].detail, /0 en el CONNACK/);

    const everything = JSON.stringify([
      opened.body,
      read.body,
      closed.body,
      [...context.repositories.channelSessions.rows.values()],
      [...context.repositories.channelSessions.messages.values()],
      [...context.repositories.channels.rows.values()],
    ]);
    assert.ok(!everything.includes(PASSWORD), "la contraseña del broker salió");
    assert.ok(!everything.includes(TOKEN), "el secreto del entorno salió");
  });

  test("una contraseña mala deja la sesión en rojo con el código, y no es un error de la API", async () => {
    const environmentId = await environment();
    const id = await channel({ auth: { type: "basic", params: { username: BROKER_USER, password: "{{token}}" } } });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.status, "error");
    assert.equal(opened.body.verdict.failure, "network");
    assert.match(opened.body.verdict.assertions[0].detail, /CONNACK 4 \(usuario o contraseña incorrectos\)/);
    assert.ok(!JSON.stringify(opened.body).includes(TOKEN));
  });

  test("una suscripción negada por el broker deja la sesión en rojo con el tema", async () => {
    const environmentId = await environment();
    const id = await channel({ mqtt: { subscriptions: [{ topic: "prohibido/#", qos: 0 }] } });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "error");
    assert.match(opened.body.verdict.assertions[0].detail, /suscripción a prohibido\/#/);
  });

  test("un broker callado se corta por inactividad, con el reloj del registro", async () => {
    const environmentId = await environment();
    const id = await channel({ mqtt: { subscriptions: [{ topic: "nadie/#", qos: 0 }] }, limits: { idleMs: 150 } });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "open");
    const read = await waitFor(opened.body.id, (body) => body.status !== "open");
    assert.equal(read.body.status, "closed", JSON.stringify(read.body));
    assert.equal(read.body.stopReason, "idle-cap");
  });
});

describe("suscripciones, testamento y propiedades", () => {
  test("suscribirse y darse de baja a mitad de sesión queda como evento, y un no del broker no la cierra", async () => {
    const environmentId = await environment();
    const id = await channel({ expectations: { minMessages: 1 } });
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
    const session = `${base}/channels/sessions/${opened.body.id}`;

    const granted = await api().post(`${session}/subscribe`).set(as(owner)).send({ topic: "jardin/#", qos: 1 });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.granted, 1);

    const denied = await api().post(`${session}/subscribe`).set(as(owner)).send({ topic: "prohibido/#" });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.granted, null);
    assert.match(denied.body.detail, /rechazó la suscripción a prohibido\/#: 128/);

    // Un filtro mal escrito es un 422 con el campo, antes de llegar al broker.
    const broken = await api().post(`${session}/subscribe`).set(as(owner)).send({ topic: "jardin/#/x" });
    assert.equal(broken.status, 422);
    assert.equal(broken.body.errors[0].field, "topic");

    await broker.publish("jardin/riego", "on");
    await waitFor(opened.body.id, (body) => body.messages.some((m) => (m as { direction: string }).direction === "in"));
    const left = await api().post(`${session}/unsubscribe`).set(as(owner)).send({ topic: "jardin/#" });
    assert.equal(left.body.detail, "ya no se oye jardin/#");

    const read = await api().get(session).set(as(owner));
    assert.equal(read.body.status, "open");
    const rows = read.body.messages as { direction: string; body: string; topic?: string }[];
    assert.deepEqual(
      rows.map((row) => [row.direction, row.topic]),
      [
        ["event", "jardin/#"],
        ["event", "prohibido/#"],
        ["in", "jardin/riego"],
        ["event", "jardin/#"],
      ],
    );
    assert.equal(read.body.counters.received, 1);

    const closed = await api().post(`${session}/close`).set(as(owner));
    assert.equal(closed.body.verdict.ok, true, JSON.stringify(closed.body.verdict));
  });

  test("en 3.1.1, publicar con propiedades de usuario es un 422 que dice que son de MQTT 5", async () => {
    const environmentId = await environment();
    const id = await channel();
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    const session = `${base}/channels/sessions/${opened.body.id}`;
    const props = await api()
      .post(`${session}/messages`)
      .set(as(owner))
      .send({ text: "x", topic: "a", userProperties: [{ name: "n", value: "v" }] });
    assert.equal(props.status, 422);
    assert.match(JSON.stringify(props.body), /MQTT 5/);
    await api().post(`${session}/close`).set(as(owner));
  });

  test("testamento y propiedades se guardan validados, y una credencial escrita a mano se guarda vacía", async () => {
    const id = await channel({
      mqtt: {
        version: 5,
        will: { topic: "estado/{{tema}}", payload: "caído", qos: 1, retain: true },
        userProperties: [
          { name: "authorization", value: `Bearer ${TOKEN}` },
          { name: "x-api-key", value: "{{token}}" },
          { name: "origen", value: "eq" },
        ],
      },
    });
    const read = await api().get(`${base}/channels/${id}`).set(as(owner));
    assert.deepEqual(read.body.mqtt.will, { topic: "estado/{{tema}}", payload: "caído", qos: 1, retain: true });
    assert.deepEqual(read.body.mqtt.userProperties, [
      { name: "authorization", value: "" },
      { name: "x-api-key", value: "{{token}}" },
      { name: "origen", value: "eq" },
    ]);
    assert.ok(!JSON.stringify(context.repositories.channels.rows.get(id)).includes(TOKEN));

    const broken = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({
        protocol: "mqtt",
        name: "roto",
        url: "mqtt://broker.example.test",
        mqtt: {
          version: 4,
          will: { topic: "estado/#", payload: 1, qos: 5, retain: "sí" },
          userProperties: [{ name: "", value: "x" }],
        },
      });
    assert.equal(broken.status, 422);
    const fields = broken.body.errors.map((error: { field: string }) => error.field).sort();
    assert.deepEqual(fields, [
      "mqtt.userProperties",
      "mqtt.userProperties.0.name",
      "mqtt.will.payload",
      "mqtt.will.qos",
      "mqtt.will.retain",
      "mqtt.will.topic",
    ]);
  });
});

describe("un canal MQTT 5 con propiedades", () => {
  test("las propiedades salen y vuelven en la transcripción, tapadas por nombre y por valor", async () => {
    const five = await startMqtt5();
    try {
      const environmentId = await environment();
      const id = await channel({ url: `mqtt://127.0.0.1:${five.port}`, auth: null, mqtt: { version: 5 } });
      const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
      assert.equal(opened.body.status, "open", JSON.stringify(opened.body));
      const session = `${base}/channels/sessions/${opened.body.id}`;
      const sent = await api()
        .post(`${session}/messages`)
        .set(as(owner))
        .send({
          text: "hola",
          topic: "eco/uno",
          userProperties: [
            { name: "x-api-key", value: "literal-que-se-tapa-por-nombre" },
            { name: "traza", value: "{{token}}" },
            { name: "origen", value: "eq" },
          ],
        });
      assert.equal(sent.status, 202, JSON.stringify(sent.body));
      const read = await waitFor(opened.body.id, (body) => body.messages.length >= 2);
      const rows = read.body.messages as { direction: string; properties?: { userProperties?: string[][] } }[];
      const expected = [
        ["x-api-key", "••••••••"],
        ["traza", "••••••••"],
        ["origen", "eq"],
      ];
      assert.deepEqual(rows[0].properties?.userProperties, expected);
      assert.equal(rows[1].direction, "in");
      assert.deepEqual(rows[1].properties?.userProperties, expected);
      await api().post(`${session}/close`).set(as(owner));

      const everything = JSON.stringify([read.body, [...context.repositories.channelSessions.messages.values()]]);
      assert.ok(!everything.includes(TOKEN), "el secreto del entorno salió en una propiedad");
      assert.ok(!everything.includes("literal-que-se-tapa-por-nombre"));
    } finally {
      await five.close();
    }
  });
});
