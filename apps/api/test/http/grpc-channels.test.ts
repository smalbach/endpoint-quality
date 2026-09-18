/**
 * Los canales gRPC por HTTP, contra un servidor gRPC de verdad en el mismo proceso.
 *
 * Las cuatro formas de llamada caben en la misma conversación que un WebSocket, y aquí se fija que
 * de verdad caben: la unaria es un «enviado» y un «recibido» y un estado; el stream de servidor, N
 * recibidos; el de cliente y el bidireccional se alimentan con «Enviar» y se terminan con el medio
 * cierre. Y lo que solo tiene gRPC: el estado con su nombre, los trailers tapados, el plazo, la
 * reflexión y un entorno sin escrituras que solo deja invocar lo declarado sin efectos.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer, type AddressInfo } from "node:net";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { SHOP_FILES, startGrpcServer, type GrpcTestServer } from "../support/grpc-server";

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

const TOKEN = "tk-grpc-no-debe-salir-5e2a";

let owner: Actor;
let base: string;
let server: GrpcTestServer;
let reflective: GrpcTestServer;

async function environment(writesAllowed = true): Promise<string> {
  const created = await api()
    .post(`${base}/environments`)
    .set(as(owner))
    .send({
      name: `entorno-${Math.random().toString(36).slice(2, 8)}`,
      baseUrl: "https://api.example.test",
      writesAllowed,
      authEnforced: false,
      variables: {
        grpcBase: { initial: `grpc://127.0.0.1:${server.port}` },
        itemId: { initial: "42" },
        token: { initial: TOKEN, sensitive: true },
      },
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.environmentId as string;
}

/** Un canal gRPC con los `.proto` del servidor subidos, y el método elegido. */
async function channel(grpc: Record<string, unknown>, over: Record<string, unknown> = {}): Promise<string> {
  const created = await api()
    .post(`${base}/channels`)
    .set(as(owner))
    .send({ protocol: "grpc", name: `tienda-${Math.random().toString(36).slice(2, 8)}`, url: "{{grpcBase}}" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id as string;
  const protos = await api().put(`${base}/channels/${id}/grpc/protos`).set(as(owner)).send({ files: SHOP_FILES });
  assert.equal(protos.status, 200, JSON.stringify(protos.body));
  const changed = await api()
    .patch(`${base}/channels/${id}`)
    .set(as(owner))
    .send({ grpc: { service: "demo.v1.Shop", ...grpc }, ...over });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  return id;
}

async function open(id: string, environmentId: string) {
  const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  return opened.body as { id: string; status: string };
}

/** La sesión cuando termina: la cierra el servidor con su estado, no un tiempo fijo. */
async function finished(sessionId: string) {
  let read = await api().get(`${base}/channels/sessions/${sessionId}`).set(as(owner));
  for (
    let attempt = 0;
    attempt < 100 && (read.body.status === "open" || read.body.status === "connecting");
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    read = await api().get(`${base}/channels/sessions/${sessionId}`).set(as(owner));
  }
  return read.body;
}

const directions = (session: { messages: { direction: string; body: string }[] }) =>
  session.messages.map((message) => [message.direction, JSON.parse(message.body)]);

before(async () => {
  context = await createTestApp();
  owner = await signUp(`grpc-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "gRPC" });
  assert.equal(project.status, 201);
  base = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
  server = await startGrpcServer();
  reflective = await startGrpcServer({ reflection: true });
});

after(async () => {
  await server.close();
  await reflective.close();
  await context.close();
});

describe("el canal gRPC", () => {
  test("los .proto se leen con sus import, y el selector recibe servicios, métodos y un ejemplo", async () => {
    const id = await channel({ method: "GetItem" });
    const schema = await api().get(`${base}/channels/${id}/grpc`).set(as(owner));
    assert.equal(schema.status, 200, JSON.stringify(schema.body));
    assert.deepEqual(
      schema.body.files.map((file: { path: string }) => file.path),
      ["protos/common/money.proto", "protos/demo/v1/shop.proto"],
    );
    const [shop] = schema.body.services;
    assert.equal(shop.name, "demo.v1.Shop");
    const byName = Object.fromEntries(shop.methods.map((method: { name: string }) => [method.name, method])) as Record<
      string,
      { clientStreaming: boolean; serverStreaming: boolean; readOnly: boolean; example: string }
    >;
    assert.deepEqual(
      [byName.Chat.clientStreaming, byName.Chat.serverStreaming, byName.Watch.serverStreaming],
      [true, true, true],
    );
    assert.equal(byName.GetItem.readOnly, true);
    assert.equal(byName.Buy.readOnly, false);
    // El ejemplo trae el tipo bien conocido de `google/protobuf`, que nadie subió.
    assert.deepEqual(JSON.parse(byName.GetItem.example), { item_id: "", count: 0, at: { seconds: "0", nanos: 0 } });
    // Y un canal nuevo afirma el estado OK desde el principio.
    const read = await api().get(`${base}/channels/${id}`).set(as(owner));
    assert.deepEqual(read.body.expectations, { status: 0 });
  });

  test("un .proto roto o con un import que falta es un 422 que nombra el fichero", async () => {
    const id = await channel({ method: "GetItem" });
    const missing = await api()
      .put(`${base}/channels/${id}/grpc/protos`)
      .set(as(owner))
      .send({ files: [SHOP_FILES[0]] });
    assert.equal(missing.status, 422, JSON.stringify(missing.body));
    assert.match(missing.body.errors[0].detail, /shop\.proto importa «common\/money\.proto»/);
    const broken = await api()
      .put(`${base}/channels/${id}/grpc/protos`)
      .set(as(owner))
      .send({ files: [{ path: "roto.proto", content: 'syntax = "proto3"; message {' }] });
    assert.equal(broken.status, 422);
    assert.match(broken.body.errors[0].detail, /roto\.proto/);
    const escape = await api()
      .put(`${base}/channels/${id}/grpc/protos`)
      .set(as(owner))
      .send({ files: [{ path: "../fuera.proto", content: "" }] });
    assert.equal(escape.status, 422);
  });

  test("lo que no vale en gRPC es un 422 con el campo", async () => {
    const response = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({
        protocol: "grpc",
        name: "roto",
        url: "https://api.example.test/demo.v1.Shop",
        headers: [{ name: "grpc-timeout", value: "1S", enabled: true }],
        expectations: { closeCode: 1000 },
        grpc: { deadlineMs: 0 },
      });
    assert.equal(response.status, 422, JSON.stringify(response.body));
    assert.deepEqual(response.body.errors.map((problem: { field: string }) => problem.field).sort(), [
      "expectations.closeCode",
      "grpc.deadlineMs",
      "headers.0.name",
      "url",
    ]);
  });

  test("una credencial escrita a mano no se guarda; una {{variable}} sí", async () => {
    const id = await channel(
      { method: "GetItem" },
      {
        headers: [
          { name: "authorization", value: "Bearer literal-en-claro-99", enabled: true },
          { name: "x-api-key", value: "{{token}}", enabled: true },
          { name: "x-tenant", value: "acme", enabled: true },
        ],
        auth: { type: "bearer", params: { token: "otro-literal-77" } },
      },
    );
    const read = await api().get(`${base}/channels/${id}`).set(as(owner));
    assert.deepEqual(
      read.body.headers.map((header: { name: string; value: string }) => [header.name, header.value]),
      [
        ["authorization", ""],
        ["x-api-key", "{{token}}"],
        ["x-tenant", "acme"],
      ],
    );
    assert.equal(read.body.auth.params.token, "");
    assert.ok(!JSON.stringify(context.repositories.channels.rows.get(id)).includes("literal"));
  });
});

describe("una llamada", () => {
  test("unaria: la credencial llega al servidor, y ningún secreto sale por la API", async () => {
    const environmentId = await environment();
    const id = await channel(
      { method: "GetItem", message: '{"item_id":"{{itemId}}","count":2}' },
      { headers: [{ name: "authorization", value: "Bearer {{token}}", enabled: true }] },
    );
    const opened = await open(id, environmentId);
    const session = await finished(opened.id);

    assert.equal(session.status, "closed", JSON.stringify(session));
    assert.equal(session.closeCode, 0);
    assert.equal(session.stopReason, "closed-by-peer");
    assert.deepEqual(directions(session), [
      ["out", { item_id: "42", count: 2 }],
      ["in", { name: "item 42", price: { units: "5", currency: "EUR" } }],
    ]);
    assert.equal(session.handshake.headers["x-server"], "demo");
    // Los trailers, tapados por nombre: `x-session-token` suena a credencial.
    assert.equal(session.trailers["x-session-token"], "••••••••");
    assert.equal(session.trailers["x-region"], "eu");
    assert.equal(session.verdict.ok, true, JSON.stringify(session.verdict));
    assert.deepEqual(
      session.verdict.assertions.map((assertion: { label: string }) => assertion.label),
      ["Conexión", "Estado OK (0)"],
    );

    assert.equal(server.received.at(-1)?.authorization, `Bearer ${TOKEN}`);
    const everything = JSON.stringify([
      session,
      (await api().get(`${base}/channels/${id}`).set(as(owner))).body,
      [...context.repositories.channelSessions.messages.values()],
    ]);
    assert.ok(!everything.includes(TOKEN));
    assert.ok(!everything.includes("abc-del-servidor"));
  });

  test("un estado de error se afirma en rojo, con su nombre y el detalle del servidor", async () => {
    const environmentId = await environment();
    const id = await channel({ method: "GetItem", message: '{"item_id":"missing"}' });
    const session = await finished((await open(id, environmentId)).id);
    assert.equal(session.closeCode, 5);
    assert.equal(session.closeReason, "no existe missing");
    assert.equal(session.verdict.ok, false);
    assert.equal(session.verdict.failure, "check");
    assert.deepEqual(session.verdict.assertions[1], {
      label: "Estado OK (0)",
      pass: false,
      detail: "terminó con NOT_FOUND (5): no existe missing",
    });
  });

  test("stream de servidor: todos los mensajes, en orden, y el estado al final", async () => {
    const environmentId = await environment();
    const id = await channel(
      { method: "Watch", message: '{"item_id":"w"}' },
      { expectations: { status: 0, minMessages: 3 } },
    );
    const session = await finished((await open(id, environmentId)).id);
    assert.deepEqual(directions(session), [
      ["out", { item_id: "w" }],
      ["in", { name: "w-1", price: null }],
      ["in", { name: "w-2", price: null }],
      ["in", { name: "w-3", price: null }],
    ]);
    assert.equal(session.verdict.ok, true, JSON.stringify(session.verdict));
  });

  test("bidireccional: se manda con «Enviar», se termina el envío, y el servidor cierra", async () => {
    const environmentId = await environment();
    const id = await channel({ method: "Chat" });
    const opened = await open(id, environmentId);
    assert.equal(opened.status, "open");
    for (const name of ["hola", "{{itemId}}"]) {
      const sent = await api()
        .post(`${base}/channels/sessions/${opened.id}/messages`)
        .set(as(owner))
        .send({ text: JSON.stringify({ name }) });
      assert.equal(sent.status, 202, JSON.stringify(sent.body));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    // Un campo que el tipo no tiene es un 422, y no sale nada.
    const wrong = await api()
      .post(`${base}/channels/sessions/${opened.id}/messages`)
      .set(as(owner))
      .send({ text: '{"nombre":"x"}' });
    assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
    assert.match(wrong.body.errors[0].detail, /no tiene el campo nombre/);

    assert.equal((await api().post(`${base}/channels/sessions/${opened.id}/end`).set(as(owner))).status, 202);
    const session = await finished(opened.id);
    assert.equal(session.closeCode, 0);
    assert.deepEqual(directions(session), [
      ["out", { name: "hola" }],
      ["in", { name: "eco hola", price: null }],
      ["out", { name: "42" }],
      ["in", { name: "eco 42", price: null }],
    ]);
  });

  test("stream de cliente: los mensajes se cuentan y la respuesta llega al terminar el envío", async () => {
    const environmentId = await environment();
    const id = await channel({ method: "Upload" });
    const opened = await open(id, environmentId);
    for (const name of ["a", "b", "c"])
      await api()
        .post(`${base}/channels/sessions/${opened.id}/messages`)
        .set(as(owner))
        .send({ text: JSON.stringify({ name }) });
    await api().post(`${base}/channels/sessions/${opened.id}/end`).set(as(owner));
    const session = await finished(opened.id);
    assert.deepEqual(directions(session).at(-1), ["in", { received: 3 }]);
  });

  test("una unaria no recibe mensajes después de invocarla: 409", async () => {
    const environmentId = await environment();
    const id = await channel({ method: "Slow", deadlineMs: 2_000 });
    const opened = await open(id, environmentId);
    const sent = await api()
      .post(`${base}/channels/sessions/${opened.id}/messages`)
      .set(as(owner))
      .send({ text: "{}" });
    assert.equal(sent.status, 409, JSON.stringify(sent.body));
    await api().post(`${base}/channels/sessions/${opened.id}/close`).set(as(owner));
  });

  test("el plazo viaja al servidor y termina la llamada con DEADLINE_EXCEEDED", async () => {
    const environmentId = await environment();
    const id = await channel({ method: "Slow", deadlineMs: 150 });
    const session = await finished((await open(id, environmentId)).id);
    assert.equal(session.closeCode, 4, JSON.stringify(session));
    assert.equal(session.verdict.assertions[1].detail.startsWith("terminó con DEADLINE_EXCEEDED (4)"), true);
  });

  test("un entorno sin escrituras solo invoca lo declarado sin efectos", async () => {
    const environmentId = await environment(false);
    const blocked = await channel({ method: "Buy", message: '{"item_id":"1"}' });
    const refused = await api().post(`${base}/channels/${blocked}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(String(refused.body.type), /writes-not-allowed$/);
    assert.match(refused.body.detail ?? refused.body.message ?? "", /NO_SIDE_EFFECTS/);

    const allowed = await channel({ method: "GetItem", message: '{"item_id":"1"}' });
    const session = await finished((await open(allowed, environmentId)).id);
    assert.equal(session.closeCode, 0);
  });

  test("un servidor que no está: la sesión en rojo, `network`, con el motivo", async () => {
    const environmentId = await environment();
    const id = await channel({ method: "GetItem" }, { url: "grpc://127.0.0.1:1" });
    const opened = await open(id, environmentId);
    assert.equal(opened.status, "error");
    const session = await finished(opened.id);
    assert.equal(session.verdict.failure, "network");
    assert.match(session.verdict.assertions[0].detail, /no se pudo conectar/);
  });
});

describe("la reflexión", () => {
  test("lista los servicios del servidor, y una sesión con reflexión llama sin .proto", async () => {
    const environmentId = await environment();
    const created = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({
        protocol: "grpc",
        name: "con-reflexion",
        url: `grpc://127.0.0.1:${reflective.port}`,
        grpc: { source: "reflection", service: "demo.v1.Shop", method: "GetItem", message: '{"item_id":"r"}' },
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const reflected = await api()
      .post(`${base}/channels/${created.body.id}/grpc/reflection`)
      .set(as(owner))
      .send({ environmentId });
    assert.equal(reflected.status, 200, JSON.stringify(reflected.body));
    assert.deepEqual(
      reflected.body.services.map((service: { name: string }) => service.name),
      ["demo.v1.Shop"],
    );
    const methods = reflected.body.services[0].methods.map((method: { name: string }) => method.name);
    assert.ok(methods.includes("Chat"), methods.join(","));

    const session = await finished((await open(created.body.id, environmentId)).id);
    assert.equal(session.closeCode, 0, JSON.stringify(session));
    assert.deepEqual(directions(session).at(-1), ["in", { name: "item r", price: { units: "5", currency: "EUR" } }]);
  });

  test("un servidor sin reflexión lo dice, en vez de una lista vacía", async () => {
    const created = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({ protocol: "grpc", name: "sin-reflexion", url: `grpc://127.0.0.1:${server.port}` });
    const reflected = await api().post(`${base}/channels/${created.body.id}/grpc/reflection`).set(as(owner)).send({});
    assert.equal(reflected.status, 422, JSON.stringify(reflected.body));
    assert.match(reflected.body.errors[0].detail, /reflexión/);
  });
});

describe("la metadata binaria (-bin)", () => {
  test("se escribe en base64, llega en bytes, y vuelve en base64", async () => {
    const environmentId = await environment();
    const id = await channel(
      { method: "GetItem", message: '{"item_id":"b"}' },
      { headers: [{ name: "x-trace-bin", value: "AAEC/w==", enabled: true }] },
    );
    const session = await finished((await open(id, environmentId)).id);
    assert.equal(session.closeCode, 0, JSON.stringify(session));
    assert.equal(server.received.at(-1)?.["x-trace-bin"], "AAEC/w==");
    assert.equal(session.trailers["x-trace-bin"], "AAEC/w==");
  });

  test("un secreto que vuelve en bytes se tapa por su valor, y una clave de credencial por su nombre", async () => {
    const environmentId = await environment();
    const id = await channel(
      { method: "GetItem", message: '{"item_id":"eco"}' },
      { headers: [{ name: "x-eco", value: "{{token}}", enabled: true }] },
    );
    const session = await finished((await open(id, environmentId)).id);
    assert.equal(session.trailers["x-eco-bin"], "••••••••");
    assert.equal(session.trailers["x-api-key-bin"], "••••••••");
    const everything = JSON.stringify([session, [...context.repositories.channelSessions.rows.values()]]);
    assert.ok(!everything.includes(Buffer.from(TOKEN).toString("base64").replace(/=+$/, "")));
    assert.ok(!everything.includes(Buffer.from("clave-binaria-del-servidor").toString("base64").slice(0, 20)));
  });

  test("un valor que no es base64 es un 422 al guardar, y al abrir si sale de una variable", async () => {
    const broken = await api()
      .post(`${base}/channels`)
      .set(as(owner))
      .send({
        protocol: "grpc",
        name: "bin-roto",
        url: "grpc://api.example.test",
        headers: [{ name: "x-trace-bin", value: "esto no es base64!", enabled: true }],
      });
    assert.equal(broken.status, 422, JSON.stringify(broken.body));
    assert.deepEqual(
      broken.body.errors.map((problem: { field: string }) => problem.field),
      ["headers.0.value"],
    );

    const environmentId = await environment();
    const id = await channel(
      { method: "GetItem", message: "{}" },
      { headers: [{ name: "x-trace-bin", value: "{{grpcBase}}", enabled: true }] },
    );
    const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({ environmentId });
    assert.equal(opened.status, 422, JSON.stringify(opened.body));
    assert.match(opened.body.errors[0].detail, /x-trace-bin: .*base64/);
  });
});

describe("la reflexión y la llamada, por una sola conexión", () => {
  test("una sesión con reflexión abre una conexión, no dos", async () => {
    // Un relé TCP delante del servidor que cuenta las conexiones que le llegan.
    let connections = 0;
    const relay = createServer((incoming) => {
      connections += 1;
      const outgoing = connect(reflective.port, "127.0.0.1");
      incoming.pipe(outgoing).pipe(incoming);
      incoming.on("error", () => outgoing.destroy());
      outgoing.on("error", () => incoming.destroy());
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    try {
      const environmentId = await environment();
      const created = await api()
        .post(`${base}/channels`)
        .set(as(owner))
        .send({
          protocol: "grpc",
          name: "reflexion-una-conexion",
          url: `grpc://127.0.0.1:${(relay.address() as AddressInfo).port}`,
          grpc: { source: "reflection", service: "demo.v1.Shop", method: "GetItem", message: '{"item_id":"u"}' },
        });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const session = await finished((await open(created.body.id, environmentId)).id);
      assert.equal(session.closeCode, 0, JSON.stringify(session));
      assert.equal(connections, 1);

      // Un método que la reflexión no conoce: la sesión en rojo con el motivo, y sin llamar.
      await api()
        .patch(`${base}/channels/${created.body.id}`)
        .set(as(owner))
        .send({ grpc: { method: "NoExiste" } });
      const missing = await finished((await open(created.body.id, environmentId)).id);
      assert.equal(missing.status, "error", JSON.stringify(missing));
      assert.match(missing.verdict.assertions[0].detail, /NoExiste/);
    } finally {
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });
});
