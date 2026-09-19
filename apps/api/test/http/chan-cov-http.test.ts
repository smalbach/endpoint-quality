/**
 * Los «no» de los canales por HTTP que las demás pruebas no piden: lo que no existe (404), lo que ya
 * terminó (409), lo que no es del protocolo (409) y cada mensaje mal formado (422), con el cuerpo de
 * Problem Details que los dice. Y un token de servicio que crea, que consta como quien lo hizo.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string; userId: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, userId: registered.body.userId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

const SOCKET = "wss://cov.example.test/socket";
let owner: Actor;
let base: string;
let projectId: string;

const problem = (body: { type?: string }) => String(body.type).split("/").pop();

async function channel(over: Record<string, unknown> = {}): Promise<string> {
  const created = await api()
    .post(`${base}/channels`)
    .set(as(owner))
    .send({ name: `c-${Math.random().toString(36).slice(2, 8)}`, url: SOCKET, ...over });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id as string;
}

/** Una sesión abierta, contra el socket guionizado. */
async function openSession(): Promise<string> {
  context.channels.script(SOCKET, {});
  const id = await channel();
  const opened = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({});
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.status, "open");
  return opened.body.id as string;
}

async function closedSession(): Promise<string> {
  const id = await openSession();
  assert.equal((await api().post(`${base}/channels/sessions/${id}/close`).set(as(owner))).status, 200);
  return id;
}

before(async () => {
  context = await createTestApp();
  owner = await signUp(`chan-cov-${Date.now()}@example.test`);
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Cobertura" });
  assert.equal(project.status, 201);
  projectId = project.body.projectId;
  base = `/orgs/${owner.organizationId}/projects/${projectId}`;
});

after(async () => {
  await context.close();
});

beforeEach(() => context.channels.reset());

describe("el canal", () => {
  test("cambiar o borrar uno que no existe es un 404; cambiarlo mal, un 422 con el campo", async () => {
    const missing = randomUUID();
    const patched = await api().patch(`${base}/channels/${missing}`).set(as(owner)).send({ name: "x" });
    assert.equal(patched.status, 404);
    assert.equal(problem(patched.body), "channel-not-found");
    const deleted = await api().delete(`${base}/channels/${missing}`).set(as(owner));
    assert.equal(deleted.status, 404);
    assert.equal(problem(deleted.body), "channel-not-found");
    const opened = await api().post(`${base}/channels/${missing}/sessions`).set(as(owner)).send({});
    assert.equal(opened.status, 404);
    assert.equal(problem(opened.body), "channel-not-found");

    const id = await channel();
    // El protocolo lo pone el canal: unos ajustes de MQTT en un WebSocket no se guardan.
    const wrong = await api()
      .patch(`${base}/channels/${id}`)
      .set(as(owner))
      .send({ mqtt: { version: 5 }, name: " " });
    assert.equal(wrong.status, 422);
    assert.deepEqual(
      wrong.body.errors.map((error: { field: string }) => error.field).sort(),
      ["mqtt", "name"],
    );
  });

  test("crear sin nombre ni URL es un 422 que nombra los dos", async () => {
    const created = await api().post(`${base}/channels`).set(as(owner)).send({});
    assert.equal(created.status, 422);
    assert.deepEqual([...new Set(created.body.errors.map((error: { field: string }) => error.field))], ["name", "url"]);
  });

  test("un token de servicio crea, y consta como quien lo hizo", async () => {
    const token = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI" });
    assert.equal(token.status, 201);
    const created = await api()
      .post(`${base}/channels`)
      .set({ Authorization: `Bearer ${token.body.token}` })
      .send({ name: "desde CI", url: SOCKET });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const stored = await context.repositories.channels.findById(projectId, created.body.id);
    assert.ok(stored?.updatedBy);
    assert.notEqual(stored?.updatedBy, owner.userId);
  });

  test("el tope de canales por proyecto es un 409 que lo dice", async () => {
    const other = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Lleno" });
    const fullBase = `/orgs/${owner.organizationId}/projects/${other.body.projectId}`;
    const template = await context.repositories.channels.findById(projectId, await channel());
    for (let index = 0; index < 200; index++)
      await context.repositories.channels.save({ ...template!, id: randomUUID(), projectId: other.body.projectId });
    const refused = await api().post(`${fullBase}/channels`).set(as(owner)).send({ name: "uno más", url: SOCKET });
    assert.equal(refused.status, 409);
    assert.equal(problem(refused.body), "channels-full");
    assert.match(refused.body.detail, /200 canales/);
  });
});

describe("una sesión que no existe o que ya terminó", () => {
  test("mandar, suscribirse, cerrar, terminar el envío y seguirla: 404", async () => {
    const missing = randomUUID();
    const calls = [
      api().post(`${base}/channels/sessions/${missing}/messages`).set(as(owner)).send({ text: "x" }),
      api().post(`${base}/channels/sessions/${missing}/subscribe`).set(as(owner)).send({ topic: "a" }),
      api().post(`${base}/channels/sessions/${missing}/unsubscribe`).set(as(owner)).send({ topic: "a" }),
      api().post(`${base}/channels/sessions/${missing}/close`).set(as(owner)),
      api().post(`${base}/channels/sessions/${missing}/end`).set(as(owner)),
      api().get(`${base}/channels/sessions/${missing}/stream`).set(as(owner)),
    ];
    for (const response of await Promise.all(calls)) {
      assert.equal(response.status, 404, JSON.stringify(response.body));
      assert.equal(problem(response.body), "channel-session-not-found");
    }
  });

  test("suscribirse o terminar el envío de una que terminó es un 409; cerrarla otra vez, no", async () => {
    const id = await closedSession();
    for (const path of ["subscribe", "unsubscribe"]) {
      const response = await api().post(`${base}/channels/sessions/${id}/${path}`).set(as(owner)).send({ topic: "a" });
      assert.equal(response.status, 409);
      assert.equal(problem(response.body), "channel-session-finished");
    }
    const ended = await api().post(`${base}/channels/sessions/${id}/end`).set(as(owner));
    assert.equal(ended.status, 409);
    assert.equal(problem(ended.body), "channel-session-finished");
    const again = await api().post(`${base}/channels/sessions/${id}/close`).set(as(owner));
    assert.equal(again.status, 200);
    assert.equal(again.body.status, "closed");
    assert.equal(again.body.live, false);
  });
});

describe("un mensaje mal formado es un 422 con el campo, antes de llegar a la sesión", () => {
  test("texto, tema, propiedades y el evento con sus argumentos", async () => {
    const id = await openSession();
    const send = (body: Record<string, unknown>) =>
      api().post(`${base}/channels/sessions/${id}/messages`).set(as(owner)).send(body);
    const cases: [Record<string, unknown>, { field: string; detail: string }[]][] = [
      [{ text: "x".repeat(64 * 1024 + 1) }, [{ field: "text", detail: "Texto, como mucho 64 KB" }]],
      [{ text: "x", topic: "a/#" }, [{ field: "topic", detail: "Un tema para publicar no lleva comodines (+ ni #)" }]],
      [
        { text: "x", topic: "a", userProperties: [{ name: "", value: "v" }] },
        [{ field: "userProperties.0.name", detail: "Falta el nombre" }],
      ],
      [
        { text: "x", event: "connect" },
        [{ field: "event", detail: "«connect» lo emite Socket.IO: no es un evento del servidor" }],
      ],
      [{ text: "", event: "e", args: [1] }, [{ field: "args", detail: "Los argumentos son una lista de textos" }]],
      [{ text: "", event: "e", args: Array.from({ length: 11 }, () => "a") }, [{ field: "args", detail: "Como mucho 10" }]],
      [
        { text: "", event: "e", args: ["x".repeat(40 * 1024), "y".repeat(40 * 1024)] },
        [{ field: "args", detail: "Entre todos, como mucho 64 KB" }],
      ],
    ];
    for (const [body, errors] of cases) {
      const response = await send(body);
      assert.equal(response.status, 422, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(response.body.errors, errors);
    }
    // Y uno bien formado pero que no es de este protocolo lo rechaza la sesión, con su motivo.
    const wrongProtocol = await send({ text: "x", event: "saludo", ack: true, args: ["a"] });
    assert.equal(wrongProtocol.status, 422);
    assert.deepEqual(wrongProtocol.body.errors, [{ field: "event", detail: "Solo un canal Socket.IO emite eventos" }]);
    const sent = await send({ text: "hola", encoding: "text" });
    assert.equal(sent.status, 202);
    assert.deepEqual(sent.body, { accepted: true });
  });
});

describe("gRPC por HTTP", () => {
  test("los .proto y la reflexión son de un canal gRPC: 404 si no existe, 409 si es de otro protocolo", async () => {
    const missing = randomUUID();
    assert.equal(problem((await api().get(`${base}/channels/${missing}/grpc`).set(as(owner))).body), "channel-not-found");
    const ws = await channel();
    const schema = await api().get(`${base}/channels/${ws}/grpc`).set(as(owner));
    assert.equal(schema.status, 409);
    assert.equal(problem(schema.body), "channel-not-grpc");
    const saved = await api().put(`${base}/channels/${ws}/grpc/protos`).set(as(owner)).send({ files: [] });
    assert.equal(saved.status, 409);
    const reflected = await api().post(`${base}/channels/${ws}/grpc/reflection`).set(as(owner)).send({});
    assert.equal(reflected.status, 409);
  });

  test("un conjunto guardado que ya no se lee se enseña con el motivo; uno vacío, sin nada", async () => {
    const id = await channel({ protocol: "grpc", url: "grpc://svc.example.test:50051" });
    const empty = await api().put(`${base}/channels/${id}/grpc/protos`).set(as(owner)).send({ files: [] });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.deepEqual(empty.body, { files: [], services: [], problem: null });

    const invalid = await api()
      .put(`${base}/channels/${id}/grpc/protos`)
      .set(as(owner))
      .send({ files: [{ path: "../fuera.proto", content: "" }] });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.errors[0].field, "files.0.path");

    // Guardado por detrás, como lo dejaría otra versión del analizador.
    await context.repositories.channelProtos.replace(id, [{ path: "viejo.proto", content: "message {" }]);
    const stale = await api().get(`${base}/channels/${id}/grpc`).set(as(owner));
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body.files, [{ path: "viejo.proto", bytes: 9 }]);
    assert.deepEqual(stale.body.services, []);
    assert.match(stale.body.problem, /viejo\.proto/);
  });

  test("abrir sin .proto ni método es una sesión que no llega a abrir: 422 con el campo", async () => {
    const id = await channel({ protocol: "grpc", url: "grpc://svc.example.test:50051" });
    const noMethod = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({});
    assert.equal(noMethod.status, 422);
    assert.deepEqual(noMethod.body.errors, [{ field: "grpc.method", detail: "Elige el servicio y el método que se invocan" }]);
    await api()
      .patch(`${base}/channels/${id}`)
      .set(as(owner))
      .send({ grpc: { service: "tienda.v1.Caja", method: "Cobrar" } });
    const noProtos = await api().post(`${base}/channels/${id}/sessions`).set(as(owner)).send({});
    assert.equal(noProtos.status, 422);
    assert.equal(noProtos.body.errors[0].field, "grpc.source");
  });

  test("terminar el envío de un WebSocket abierto es un 409 que dice que no hay envío que terminar", async () => {
    const id = await openSession();
    const ended = await api().post(`${base}/channels/sessions/${id}/end`).set(as(owner));
    assert.equal(ended.status, 409);
    assert.equal(problem(ended.body), "channel-no-half-close");
  });
});
