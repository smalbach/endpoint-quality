/**
 * El nodo canal, corrido por el motor de verdad: un WebSocket guionizado, un broker MQTT `aedes` en
 * proceso y un servidor gRPC de verdad en loopback.
 *
 * Lo que tiene que ser cierto: que el veredicto del caso es el de la conversación —y el fallo, de quien
 * es—; que lo que el canal recibe lo leen las capturas y los pasos siguientes sin tapar; que lo que se
 * guarda en `run_cases` y `run_steps` sí va tapado; y que las protecciones de una sesión interactiva
 * —la guarda de red, el entorno sin escrituras, los métodos gRPC sin efectos— valen igual aquí, porque
 * esto abre por el mismo sitio.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML } from "../support/stub-target";
import { BROKER_USER, startAedes, type TestBroker } from "../support/mqtt-broker";
import { SHOP_FILES, startGrpcServer, type GrpcTestServer } from "../support/grpc-server";

let context: TestContext;
let target: StubTarget;
let broker: TestBroker;
let grpc: GrpcTestServer;
const api = () => request(context.app.getHttpServer());

const SOCKET = "wss://eco.example.test/socket";
const TOKEN = "tk-flujo-canal-no-debe-salir-3f9a";
const PASSWORD = "clave-broker-flujo-no-debe-salir-8d21";

type Actor = { organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
let projectBase: string;

type RunCaseRow = {
  id: string;
  scenarioId: string;
  status: string;
  method: string;
  path: string;
  failure: string | null;
};
type StepRow = {
  request: { method: string; body: unknown };
  actual: { status: number; body: Record<string, unknown> } | null;
  assertions: { label: string; pass: boolean; detail: string }[];
};

async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}

async function environment(writesAllowed = true): Promise<string> {
  const created = await api()
    .post(`${projectBase}/environments`)
    .set(as(owner))
    .send({
      name: `entorno-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed,
      authEnforced: false,
      variables: {
        wsBase: { initial: "wss://eco.example.test" },
        broker: { initial: `mqtt://127.0.0.1:${broker.port}` },
        grpcBase: { initial: `grpc://127.0.0.1:${grpc.port}` },
        itemId: { initial: "42" },
        token: { initial: TOKEN, sensitive: true },
        mqttPass: { initial: PASSWORD, sensitive: true },
      },
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.environmentId as string;
}

async function channel(body: Record<string, unknown>): Promise<{ id: string; name: string }> {
  const name = `canal-${Math.random().toString(36).slice(2, 8)}`;
  const created = await api()
    .post(`${projectBase}/channels`)
    .set(as(owner))
    .send({ name, ...body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.id as string, name };
}

async function grpcChannel(grpcSettings: Record<string, unknown>): Promise<{ id: string; name: string }> {
  const created = await channel({ protocol: "grpc", url: "{{grpcBase}}" });
  const protos = await api()
    .put(`${projectBase}/channels/${created.id}/grpc/protos`)
    .set(as(owner))
    .send({ files: SHOP_FILES });
  assert.equal(protos.status, 200, JSON.stringify(protos.body));
  const changed = await api()
    .patch(`${projectBase}/channels/${created.id}`)
    .set(as(owner))
    .send({ grpc: { service: "demo.v1.Shop", ...grpcSettings } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  return created;
}

async function flow(steps: unknown[]): Promise<string> {
  const created = await api()
    .post(`${projectBase}/workflows`)
    .set(as(owner))
    .send({ name: `flujo-${Math.random().toString(36).slice(2, 8)}`, definition: { steps } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.workflowId as string;
}

async function run(workflowId: string, environmentId: string) {
  const started = await api().post(`${projectBase}/runs`).set(as(owner)).send({ environmentId, workflowId });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await context.queue.idle();
  const read = await api().get(`${projectBase}/runs/${started.body.runId}`).set(as(owner));
  const cases = read.body.cases as RunCaseRow[];
  const caseOf = (stepId: string) => cases.find((item) => item.scenarioId.endsWith(`:${stepId}`)) as RunCaseRow;
  const detailOf = async (stepId: string): Promise<StepRow> =>
    (
      await api()
        .get(`${projectBase}/runs/${started.body.runId}/cases/${caseOf(stepId).id}`)
        .set(as(owner))
    ).body.steps[0];
  return { id: started.body.runId as string, caseOf, detailOf };
}

/** Todo lo que la corrida y los canales guardaron, como texto: donde no puede aparecer un secreto. */
const everythingStored = () =>
  JSON.stringify([
    [...context.repositories.runs.cases.values()],
    [...context.repositories.runs.steps.values()],
    [...context.repositories.channelSessions.rows.values()],
    [...context.repositories.channelSessions.messages.values()],
  ]);

const check = (path: string, value: unknown, at = "last") => ({
  source: "message",
  path,
  operator: "equals",
  value,
  match: { at },
});

before(async () => {
  context = await createTestApp();
  target = new StubTarget({});
  await target.start();
  broker = await startAedes({ password: PASSWORD });
  grpc = await startGrpcServer();
  owner = await signUp(`flujo-canal-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Canales" });
  projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
  const imported = await api()
    .post(`${projectBase}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
});

after(async () => {
  await context?.close();
  await target?.stop();
  await broker?.close();
  await grpc?.close();
});

beforeEach(() => context.channels.reset());

describe("un nodo canal WebSocket", () => {
  test("pasa con el veredicto del canal, captura sin tapar y guarda tapado", async () => {
    context.channels.script(SOCKET, {
      greeting: ['{"type":"hello"}'],
      // Devuelve lo recibido —con el token dentro— y un billete que solo el servidor conoce.
      reply: (text) => [JSON.stringify({ type: "ok", ticket: "b-777", echo: text })],
    });
    const socket = await channel({
      url: "{{wsBase}}/socket",
      expectations: { minMessages: 2, checks: [check("type", "ok")] },
    });
    const environmentId = await environment();
    const workflowId = await flow([
      { id: "saludo", kind: "set", set: { assignments: [{ variable: "saludo", value: "hola" }] } },
      {
        id: "socket",
        kind: "channel",
        dependsOn: ["saludo"],
        channel: {
          channelId: socket.id,
          messages: [{ action: "send", body: '{"auth":"{{token}}","msg":"{{saludo}}"}' }],
        },
        captures: [{ variable: "billete", from: "body", path: "last.ticket" }],
      },
      {
        id: "copia",
        kind: "mock",
        dependsOn: ["socket"],
        mock: { status: 200, body: '{"billete":"{{billete}}"}' },
        checks: [{ source: "body", path: "billete", operator: "equals", value: "b-777" }],
      },
    ]);

    const result = await run(workflowId, environmentId);
    assert.equal(result.caseOf("socket").status, "passed");
    assert.equal(result.caseOf("socket").method, "WS");
    assert.equal(result.caseOf("socket").path, `«${socket.name}»`);
    assert.equal(result.caseOf("copia").status, "passed", "el paso siguiente lee la captura");

    // Viajó de verdad, con el token y la variable de la corrida resueltos.
    assert.deepEqual(JSON.parse(context.channels.sent[0]!.text), { auth: TOKEN, msg: "hola" });

    const detail = await result.detailOf("socket");
    const labels = detail.assertions.map((assertion) => assertion.label);
    assert.equal(labels[0], "Sesión de canal");
    assert.ok(labels.includes("Al menos 2 mensaje(s)"), JSON.stringify(labels));
    assert.ok(labels.includes("Variables capturadas"), JSON.stringify(labels));
    assert.equal(detail.actual!.status, 101);
    const transcript = detail.actual!.body.transcript as { direction: string; body: string }[];
    assert.deepEqual(
      transcript.map((message) => message.direction),
      ["in", "out", "in"],
    );
    assert.match(transcript[1]!.body, /••••••••/);
    // Lo enviado se guarda como se escribió: la plantilla, no el valor.
    assert.match(JSON.stringify(detail.request.body), /\{\{token\}\}/);
    assert.ok(!everythingStored().includes(TOKEN), "el token no aparece en nada guardado");
  });

  test("falla con el veredicto del canal, y lo que depende de él se salta", async () => {
    context.channels.script(SOCKET, { greeting: ['{"type":"hello"}'] });
    const socket = await channel({
      url: "{{wsBase}}/socket",
      expectations: { minMessages: 1, checks: [check("type", "adiós")] },
    });
    const workflowId = await flow([
      { id: "socket", kind: "channel", channel: { channelId: socket.id, messages: [] } },
      { id: "despues", kind: "set", dependsOn: ["socket"], set: { assignments: [{ variable: "x", value: "y" }] } },
    ]);
    const result = await run(workflowId, await environment());
    assert.equal(result.caseOf("socket").status, "failed");
    assert.equal(result.caseOf("socket").failure, "check");
    assert.equal(result.caseOf("despues").status, "skipped");
  });

  test("sin guion manda los mensajes guardados del canal, en orden", async () => {
    context.channels.script(SOCKET, { reply: (text) => [`eco ${text}`] });
    const socket = await channel({
      url: "{{wsBase}}/socket",
      messages: [
        { name: "uno", body: "primero" },
        { name: "dos", body: "segundo" },
      ],
      expectations: { minMessages: 2 },
    });
    const workflowId = await flow([{ id: "socket", kind: "channel", channel: { channelId: socket.id } }]);
    const result = await run(workflowId, await environment());
    assert.equal(result.caseOf("socket").status, "passed");
    assert.deepEqual(
      context.channels.sent.map((sent) => sent.text),
      ["primero", "segundo"],
    );
  });

  test("un entorno sin escrituras deja escuchar y no deja mandar, como en la pantalla", async () => {
    context.channels.script(SOCKET, { greeting: ['{"type":"hello"}'], reply: () => ["no debería"] });
    const socket = await channel({ url: "{{wsBase}}/socket", expectations: { minMessages: 1 } });
    const readOnly = await environment(false);

    const listening = await run(
      await flow([{ id: "socket", kind: "channel", channel: { channelId: socket.id, messages: [] } }]),
      readOnly,
    );
    assert.equal(listening.caseOf("socket").status, "passed");

    const sending = await run(
      await flow([
        {
          id: "socket",
          kind: "channel",
          channel: { channelId: socket.id, messages: [{ action: "send", body: "hola" }] },
        },
      ]),
      readOnly,
    );
    assert.equal(sending.caseOf("socket").status, "failed");
    assert.equal(sending.caseOf("socket").failure, "config");
    const detail = await sending.detailOf("socket");
    const guion = detail.assertions.find((assertion) => assertion.label === "Guion");
    assert.match(guion!.detail, /no permite escrituras/);
    assert.equal(context.channels.sent.length, 0, "no salió nada");
  });

  test("no se guarda un flujo que nombra un canal de otro proyecto o que no existe", async () => {
    const saved = await api()
      .post(`${projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "canal fantasma",
        definition: {
          steps: [{ id: "c", kind: "channel", channel: { channelId: "00000000-0000-4000-8000-000000000001" } }],
        },
      });
    assert.equal(saved.status, 422);
    assert.equal(saved.body.errors[0].field, "definition.steps.0.channel.channelId");
  });

  test("un canal que ya no existe es un rojo de configuración, no un error de la corrida", async () => {
    const socket = await channel({ url: "{{wsBase}}/socket" });
    const workflowId = await flow([{ id: "socket", kind: "channel", channel: { channelId: socket.id } }]);
    assert.equal((await api().delete(`${projectBase}/channels/${socket.id}`).set(as(owner))).status, 204);
    const result = await run(workflowId, await environment());
    assert.equal(result.caseOf("socket").status, "failed");
    assert.equal(result.caseOf("socket").failure, "config");
    assert.match((await result.detailOf("socket")).assertions[0]!.detail, /ya no existe/);
  });
});

describe("un nodo canal MQTT", () => {
  test("publica el mensaje guardado, recibe por su suscripción y la contraseña no se guarda", async () => {
    const mqtt = await channel({
      protocol: "mqtt",
      url: "{{broker}}",
      auth: { type: "basic", params: { username: BROKER_USER, password: "{{mqttPass}}" } },
      mqtt: { version: 4, subscriptions: [{ topic: "casa/+/temp", qos: 1 }] },
      messages: [{ name: "lectura", body: '{"t":21,"clave":"{{mqttPass}}"}', topic: "casa/salon/temp", qos: 1 }],
      expectations: { minMessages: 1, checks: [check("t", 21, "first")] },
    });
    const workflowId = await flow([
      {
        id: "broker",
        kind: "channel",
        channel: { channelId: mqtt.id },
        captures: [{ variable: "temperatura", from: "body", path: "last.t" }],
      },
      {
        id: "leer",
        kind: "mock",
        dependsOn: ["broker"],
        mock: { status: 200, body: '{"t":"{{temperatura}}"}' },
        checks: [{ source: "body", path: "t", operator: "equals", value: "21" }],
      },
    ]);
    const result = await run(workflowId, await environment());
    assert.equal(
      result.caseOf("broker").status,
      "passed",
      JSON.stringify((await result.detailOf("broker")).assertions),
    );
    assert.equal(result.caseOf("broker").method, "MQTT");
    assert.equal(result.caseOf("leer").status, "passed");
    const detail = await result.detailOf("broker");
    const topics = (detail.actual!.body.topics as (string | null)[]).filter(Boolean);
    assert.deepEqual(topics, ["casa/salon/temp"]);
    assert.ok(!everythingStored().includes(PASSWORD), "la contraseña del broker no aparece en nada guardado");
  });

  test("un mensaje sin tema en MQTT no abre nada: es un rojo de configuración", async () => {
    const mqtt = await channel({
      protocol: "mqtt",
      url: "{{broker}}",
      auth: { type: "basic", params: { username: BROKER_USER, password: "{{mqttPass}}" } },
      mqtt: { version: 4, subscriptions: [{ topic: "casa/#", qos: 0 }] },
    });
    const workflowId = await flow([
      { id: "broker", kind: "channel", channel: { channelId: mqtt.id, messages: [{ action: "send", body: "x" }] } },
    ]);
    const result = await run(workflowId, await environment());
    assert.equal(result.caseOf("broker").failure, "config");
    assert.match((await result.detailOf("broker")).assertions[0]!.detail, /tema/);
  });
});

describe("un nodo canal gRPC", () => {
  test("unaria con la petición del nodo: estado OK y la respuesta capturada", async () => {
    const shop = await grpcChannel({ method: "GetItem", message: '{"item_id":"1"}' });
    const workflowId = await flow([
      {
        id: "tienda",
        kind: "channel",
        channel: { channelId: shop.id, request: '{"item_id":"{{itemId}}"}' },
        captures: [{ variable: "nombre", from: "body", path: "last.name" }],
      },
      {
        id: "leer",
        kind: "mock",
        dependsOn: ["tienda"],
        mock: { status: 200, body: '{"n":"{{nombre}}"}' },
        checks: [{ source: "body", path: "n", operator: "equals", value: "item 42" }],
      },
    ]);
    const result = await run(workflowId, await environment());
    assert.equal(
      result.caseOf("tienda").status,
      "passed",
      JSON.stringify((await result.detailOf("tienda")).assertions),
    );
    assert.equal(result.caseOf("tienda").method, "GRPC");
    assert.equal(result.caseOf("leer").status, "passed");
    const labels = (await result.detailOf("tienda")).assertions.map((assertion) => assertion.label);
    assert.ok(labels.includes("Estado OK (0)"), JSON.stringify(labels));
  });

  test("stream de servidor, y stream de cliente que se termina solo al acabar el guion", async () => {
    const watch = await grpcChannel({ method: "Watch", message: '{"item_id":"w"}' });
    const upload = await grpcChannel({ method: "Upload" });
    const workflowId = await flow([
      { id: "mirar", kind: "channel", channel: { channelId: watch.id } },
      {
        id: "subir",
        kind: "channel",
        channel: {
          channelId: upload.id,
          messages: [
            { action: "send", body: '{"name":"a"}' },
            { action: "send", body: '{"name":"b"}', delayMs: 5 },
          ],
        },
        captures: [{ variable: "recibidos", from: "body", path: "last.received" }],
      },
    ]);
    const result = await run(workflowId, await environment());
    assert.equal(result.caseOf("mirar").status, "passed");
    const mirar = await result.detailOf("mirar");
    assert.equal(mirar.actual!.body.count, 3);
    assert.equal(result.caseOf("subir").status, "passed", JSON.stringify((await result.detailOf("subir")).assertions));
    assert.deepEqual((await result.detailOf("subir")).actual!.body.last, { received: 2 });
  });

  test("un entorno sin escrituras solo invoca lo declarado sin efectos", async () => {
    const readOnly = await environment(false);
    const buy = await grpcChannel({ method: "Buy", message: '{"item_id":"1"}' });
    const get = await grpcChannel({ method: "GetItem", message: '{"item_id":"1"}' });
    const workflowId = await flow([
      { id: "comprar", kind: "channel", channel: { channelId: buy.id } },
      { id: "leer", kind: "channel", channel: { channelId: get.id } },
    ]);
    const before = grpc.received.length;
    const result = await run(workflowId, readOnly);
    assert.equal(result.caseOf("comprar").status, "failed");
    assert.equal(result.caseOf("comprar").failure, "config");
    assert.match((await result.detailOf("comprar")).assertions[0]!.detail, /no permite escrituras/);
    assert.equal(result.caseOf("leer").status, "passed");
    assert.equal(grpc.received.length, before + 1, "solo llegó la llamada sin efectos");
  });
});

describe("con reflexión", () => {
  test("un entorno sin escrituras es un rojo de configuración, no de red, aunque el método se resuelva al conectar", async () => {
    const reflective = await startGrpcServer({ reflection: true });
    try {
      const created = await channel({
        protocol: "grpc",
        url: `grpc://127.0.0.1:${reflective.port}`,
        grpc: { source: "reflection", service: "demo.v1.Shop", method: "Buy", message: '{"item_id":"1"}' },
      });
      const workflowId = await flow([{ id: "comprar", kind: "channel", channel: { channelId: created.id } }]);
      const result = await run(workflowId, await environment(false));
      assert.equal(result.caseOf("comprar").status, "failed");
      assert.equal(result.caseOf("comprar").failure, "config");
      const detail = (await result.detailOf("comprar")).assertions.map((assertion) => assertion.detail).join("\n");
      assert.match(detail, /no permite escrituras/);
      assert.doesNotMatch(detail, /no se pudo conectar/);
    } finally {
      await reflective.close();
    }
  });
});

describe("un monitor", () => {
  test("cuyo plan es un flujo con un nodo canal corre y sale en verde", async () => {
    context.channels.script(SOCKET, { greeting: ['{"type":"hello"}'] });
    const socket = await channel({ url: "{{wsBase}}/socket", expectations: { minMessages: 1 } });
    const environmentId = await environment();
    const workflowId = await flow([{ id: "socket", kind: "channel", channel: { channelId: socket.id, messages: [] } }]);
    const created = await api()
      .post(`${projectBase}/monitors`)
      .set(as(owner))
      .send({ name: "socket vivo", schedule: { kind: "interval", minutes: 60 }, plan: { environmentId, workflowId } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const now = await api().post(`${projectBase}/monitors/${created.body.id}/runs`).set(as(owner)).send({});
    assert.equal(now.status, 202, JSON.stringify(now.body));
    await context.queue.idle();
    const monitors = (await api().get(`${projectBase}/monitors`).set(as(owner))).body.monitors as {
      id: string;
      recent: { outcome: string }[];
    }[];
    assert.equal(monitors.find((monitor) => monitor.id === created.body.id)!.recent[0]!.outcome, "passed");
    assert.equal(context.channels.opened.length, 1);
  });
});

describe("con la guarda de red de producción", () => {
  test("un canal hacia loopback no se abre: rojo de configuración con el motivo", async () => {
    const guarded = await createTestApp({ channelPrivateTargets: false });
    const guardedApi = () => request(guarded.app.getHttpServer());
    try {
      const password = "Una-contraseña-larga-1";
      const email = `guarda-${Date.now()}@example.test`;
      const registered = await guardedApi().post("/auth/register").send({ email, password, name: "x" });
      const login = await guardedApi().post("/auth/login").send({ email, password });
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };
      const project = await guardedApi()
        .post(`/orgs/${registered.body.organizationId}/projects`)
        .set(auth)
        .send({ name: "Guarda" });
      const guardedBase = `/orgs/${registered.body.organizationId}/projects/${project.body.projectId}`;
      await guardedApi()
        .post(`${guardedBase}/spec-versions`)
        .set(auth)
        .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
      const env = await guardedApi()
        .post(`${guardedBase}/environments`)
        .set(auth)
        .send({ name: "local", baseUrl: target.origin, writesAllowed: true, authEnforced: false });
      const socket = await guardedApi()
        .post(`${guardedBase}/channels`)
        .set(auth)
        .send({ name: "interno", url: "ws://127.0.0.1:9/socket" });
      assert.equal(socket.status, 201, JSON.stringify(socket.body));
      const workflow = await guardedApi()
        .post(`${guardedBase}/workflows`)
        .set(auth)
        .send({
          name: "hacia dentro",
          definition: { steps: [{ id: "socket", kind: "channel", channel: { channelId: socket.body.id } }] },
        });
      assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
      const started = await guardedApi()
        .post(`${guardedBase}/runs`)
        .set(auth)
        .send({ environmentId: env.body.environmentId, workflowId: workflow.body.workflowId });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      await guarded.queue.idle();
      const read = await guardedApi().get(`${guardedBase}/runs/${started.body.runId}`).set(auth);
      const [row] = read.body.cases as RunCaseRow[];
      assert.equal(row!.status, "failed");
      assert.equal(row!.failure, "config");
      const detail = await guardedApi().get(`${guardedBase}/runs/${started.body.runId}/cases/${row!.id}`).set(auth);
      const connection = (detail.body.steps[0] as StepRow).assertions.find(
        (assertion) => assertion.label === "Conexión",
      );
      assert.match(connection!.detail, /loopback|privad/i);
    } finally {
      await guarded.close();
    }
  });
});
