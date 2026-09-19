/**
 * Dos instancias de la API detrás de un balanceador, en un solo proceso de pruebas.
 *
 * Comparten lo que dos réplicas comparten de verdad —la base de datos (los mismos repositorios en
 * memoria) y el bus (un hub en memoria que entrega a la otra en un turno posterior y por JSON, como
 * Redis)— y nada más: cada una tiene su cola, sus sockets, sus streams y su registro de sesiones.
 *
 * Cada prueba es algo que con dos réplicas estaba roto: el progreso de una corrida que se ejecuta en
 * A no llegaba a quien la miraba desde B; un mensaje de canal mandado por B era un 409 porque el
 * socket lo tenía A; un «Cancelar» que entraba por B no cancelaba nada en A. Y una que ya estaba
 * bien y se comprueba igual: un monitor vencido dispara una vez aunque los dos relojes miren. Y «una
 * prueba de carga a la vez», que era por proceso: con dos réplicas, dos cargas contra el mismo destino.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { CommandBus } from "@nestjs/cqrs";

import { InMemoryBusHub, InMemoryInstanceBus } from "@/shared/bus/in-memory-instance-bus";
import { FireDueMonitorsCommand, type FireDueResult } from "@/modules/monitors/application/commands/fire-due-monitors";
import { ChannelSessionRegistry } from "@/modules/channels/infrastructure/session-registry";
import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML } from "../support/stub-target";
import { startSocketIo } from "../support/socketio-server";

let a: TestContext;
let b: TestContext;
const on = (context: TestContext) => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

const SOCKET = "wss://eco.example.test/multi";
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Un SSE leído hasta que se cierra, en eventos. */
async function follow(context: TestContext, path: string) {
  const response = await on(context)
    .get(path)
    .set(as(owner))
    .buffer(true)
    .parse((res, done) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => done(null, text));
    });
  assert.equal(response.status, 200, String(response.body));
  return String(response.body)
    .split("\n\n")
    .filter(Boolean)
    .map((block) => ({
      type: /^event: (.*)$/m.exec(block)?.[1] ?? "",
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null") as Record<string, unknown>,
    }));
}

/** Un proyecto contra un objetivo lento, para que la corrida dure lo bastante como para mirarla. */
async function project(slowMs: number) {
  const target = new StubTarget({ slowMs });
  await target.start();
  const created = await on(a)
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `multi-${Math.random().toString(36).slice(2, 8)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const projectBase = `/orgs/${owner.organizationId}/projects/${created.body.projectId}`;
  const imported = await on(a)
    .post(`${projectBase}/spec-versions`)
    .set(as(owner))
    .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  await on(a)
    .put(`${projectBase}/config/parameters`)
    .set(as(owner))
    .send({
      parameterSamples: {},
      fallbackSamples: ["test"],
      excludeFromSoloScenarios: [],
      pathDefaults: { id: "1" },
      fallbackPathValue: "1",
      missingIdValue: "no-existe",
    });
  const environment = await on(a)
    .post(`${projectBase}/environments`)
    .set(as(owner))
    .send({
      name: "stub",
      baseUrl: target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed: true,
      authEnforced: false,
      variables: { wsBase: { initial: "wss://eco.example.test" } },
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  return { target, projectBase, environmentId: environment.body.environmentId as string };
}

before(async () => {
  const hub = new InMemoryBusHub();
  a = await createTestApp({ bus: new InMemoryInstanceBus(hub, "instancia-a") });
  b = await createTestApp({ sibling: a, bus: new InMemoryInstanceBus(hub, "instancia-b") });
  const password = "Una-contraseña-larga-1";
  const email = `multi-${Date.now()}@example.test`;
  const registered = await on(a).post("/auth/register").send({ email, password, name: "multi" });
  // El login por la otra: la sesión es de la base de datos, no de la instancia.
  const session = await on(b).post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  owner = {
    userId: registered.body.userId,
    organizationId: registered.body.organizationId,
    token: session.body.accessToken,
  };
});

after(async () => {
  await b?.close();
  await a?.close();
});

describe("una corrida que ejecuta A, mirada desde B", () => {
  test("quien sigue desde B ve los casos en vivo y el final, no solo la foto", async () => {
    const { target, projectBase, environmentId } = await project(120);
    const started = await on(a).post(`${projectBase}/runs`).set(as(owner)).send({ environmentId });
    assert.equal(started.status, 202, JSON.stringify(started.body));

    const events = await follow(b, `${projectBase}/runs/${started.body.runId}/stream`);
    await a.queue.idle();

    assert.equal(events[0].type, "snapshot", "abrió con la corrida ya terminada: el objetivo no fue lo bastante lento");
    assert.ok(
      events.some((event) => event.type === "case"),
      `B no vio ningún caso en vivo: ${events.map((event) => event.type).join(", ")}`,
    );
    assert.equal(events[events.length - 1].type, "finished");
    await target.stop();
  });

  test("«Cancelar» por B cancela la corrida que ejecuta A", async () => {
    const { target, projectBase, environmentId } = await project(150);
    const started = await on(a).post(`${projectBase}/runs`).set(as(owner)).send({ environmentId });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await settle();

    const cancelled = await on(b).post(`${projectBase}/runs/${started.body.runId}/cancel`).set(as(owner));
    assert.equal(cancelled.status, 204, JSON.stringify(cancelled.body));
    await a.queue.idle();

    const run = await on(b).get(`${projectBase}/runs/${started.body.runId}`).set(as(owner));
    assert.equal(run.body.status, "cancelled", "la señal se quedó en B y A siguió hasta el final");
    await target.stop();
  });
});

describe("una sesión de canal cuyo socket tiene A, usada desde B", () => {
  test("B la ve viva, la sigue en vivo, manda por ella y la cierra", async () => {
    const { target, projectBase, environmentId } = await project(0);
    a.channels.script(SOCKET, { greeting: ['{"hola":1}'], reply: (text) => [`{"eco":${JSON.stringify(text)}}`] });
    const channel = await on(a)
      .post(`${projectBase}/channels`)
      .set(as(owner))
      .send({ name: "eco", url: "{{wsBase}}/multi" });
    assert.equal(channel.status, 201, JSON.stringify(channel.body));
    const opened = await on(a)
      .post(`${projectBase}/channels/${channel.body.id}/sessions`)
      .set(as(owner))
      .send({ environmentId });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const sessionId = opened.body.id as string;
    await settle();

    const read = await on(b).get(`${projectBase}/channels/sessions/${sessionId}`).set(as(owner));
    assert.equal(read.body.live, true, "B dice que no se puede usar una sesión que A tiene abierta");

    const following = follow(b, `${projectBase}/channels/sessions/${sessionId}/stream`);
    await settle();
    const sent = await on(b)
      .post(`${projectBase}/channels/sessions/${sessionId}/messages`)
      .set(as(owner))
      .send({ text: "desde-b" });
    assert.ok(sent.status < 300, `mandar por B: ${sent.status} ${JSON.stringify(sent.body)}`);
    assert.deepEqual(
      a.channels.sent.filter((entry) => entry.url === SOCKET).map((entry) => entry.text),
      ["desde-b"],
      "el mensaje no llegó al socket, que está en A",
    );
    await settle();

    const closed = await on(b).post(`${projectBase}/channels/sessions/${sessionId}/close`).set(as(owner));
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.status, "closed");
    assert.equal(a.app.get(ChannelSessionRegistry).size, 0, "el socket de A sigue abierto");

    const events = await following;
    assert.equal(events[0].type, "snapshot");
    const bodies = events
      .filter((event) => event.type === "message")
      .map((event) => (event.data.message as { body: string }).body);
    assert.ok(bodies.includes('{"eco":"desde-b"}'), `B no vio la respuesta en vivo: ${JSON.stringify(bodies)}`);
    assert.equal(events[events.length - 1].type, "finished");
    await target.stop();
  });

  test("con su dueña sin latir es un 409, como antes: nadie puede usar ya ese socket", async () => {
    // Una fila de una instancia que no está en el bus y cuyo último latido es de hace un minuto.
    const { target, projectBase, environmentId } = await project(0);
    a.channels.script(SOCKET, { greeting: [] });
    const channel = await on(a)
      .post(`${projectBase}/channels`)
      .set(as(owner))
      .send({ name: "huérfana", url: "{{wsBase}}/multi" });
    const opened = await on(a)
      .post(`${projectBase}/channels/${channel.body.id}/sessions`)
      .set(as(owner))
      .send({ environmentId });
    const stored = a.repositories.channelSessions.rows.get(opened.body.id)!;
    const ghost = {
      ...stored,
      id: crypto.randomUUID(),
      ownerInstance: "muerta:1:00000000",
      heartbeatAt: new Date(a.clock.now().getTime() - 60_000),
    };
    await a.repositories.channelSessions.save(ghost);

    const read = await on(b).get(`${projectBase}/channels/sessions/${ghost.id}`).set(as(owner));
    assert.equal(read.body.live, false);
    const sent = await on(b)
      .post(`${projectBase}/channels/sessions/${ghost.id}/messages`)
      .set(as(owner))
      .send({ text: "hola" });
    assert.equal(sent.status, 409);
    assert.match(String(sent.body.type), /channel-session-not-here$/);
    await on(a).post(`${projectBase}/channels/sessions/${opened.body.id}/close`).set(as(owner));
    await target.stop();
  });
});

describe("un canal Socket.IO cuyo socket tiene A, usado desde B", () => {
  test("el evento, sus argumentos y el acuse cruzan el bus: no llega un mensaje sin nombre", async () => {
    const { target, projectBase, environmentId } = await project(0);
    const server = await startSocketIo();
    try {
      const channel = await on(a)
        .post(`${projectBase}/channels`)
        .set(as(owner))
        .send({ protocol: "socketio", name: "sio-multi", url: server.url });
      assert.equal(channel.status, 201, JSON.stringify(channel.body));
      const opened = await on(a)
        .post(`${projectBase}/channels/${channel.body.id}/sessions`)
        .set(as(owner))
        .send({ environmentId });
      assert.equal(opened.status, 201, JSON.stringify(opened.body));
      const sessionId = opened.body.id as string;
      const session = `${projectBase}/channels/sessions/${sessionId}`;

      // Por B, que no tiene el socket: sin el evento en la orden, A recibiría un «send» sin nombre y
      // lo rechazaría con un 422 que B contestaría como suyo.
      const sum = await on(b)
        .post(`${session}/messages`)
        .set(as(owner))
        .send({ text: '{"a":2,"b":3}', event: "sumar", ack: true });
      assert.equal(sum.status, 202, JSON.stringify(sum.body));
      const echo = await on(b)
        .post(`${session}/messages`)
        .set(as(owner))
        .send({ text: "", event: "eco", args: ["desde-b"] });
      assert.equal(echo.status, 202, JSON.stringify(echo.body));

      type Message = { direction: string; event?: string | null; ack?: boolean; body: string };
      let messages: Message[] = [];
      for (let attempt = 0; attempt < 80; attempt += 1) {
        messages = (await on(b).get(session).set(as(owner))).body.messages as Message[];
        const acked = messages.some((message) => message.ack && message.body.includes('"total":5'));
        const echoed = messages.some((message) => message.direction === "in" && message.event === "eco");
        if (acked && echoed) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const sent = messages.filter((message) => message.direction === "out").map((message) => message.event);
      assert.deepEqual(sent, ["sumar", "eco"], JSON.stringify(messages));
      assert.ok(
        messages.some((message) => message.ack && message.body.includes('"total":5')),
        `el acuse no volvió: ${JSON.stringify(messages)}`,
      );
      assert.ok(
        messages.some(
          (message) => message.direction === "in" && message.event === "eco" && message.body.includes("desde-b"),
        ),
        `el eco no volvió: ${JSON.stringify(messages)}`,
      );
      await on(b).post(`${session}/close`).set(as(owner));
    } finally {
      await server.close();
      await target.stop();
    }
  });
});

describe("monitores con dos relojes", () => {
  test("un monitor vencido dispara una vez aunque las dos instancias pasen turno a la vez", async () => {
    const { target, projectBase, environmentId } = await project(0);
    const created = await on(a)
      .post(`${projectBase}/monitors`)
      .set(as(owner))
      .send({
        name: "cada hora",
        schedule: { kind: "interval", minutes: 60 },
        plan: { environmentId, operationIds: ["listThings"] },
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    a.clock.advance(61 * 60_000);

    const [fromA, fromB] = await Promise.all(
      [a, b].map((context) =>
        context.app.get(CommandBus).execute<FireDueMonitorsCommand, FireDueResult>(new FireDueMonitorsCommand()),
      ),
    );
    await Promise.all([a.queue.idle(), b.queue.idle()]);

    assert.equal(fromA.claimed + fromB.claimed, 1, "las dos instancias reclamaron el mismo turno");
    assert.equal(fromA.started + fromB.started, 1);
    const runs = [...a.repositories.monitors.executions.values()].filter(
      (execution) => execution.monitorId === created.body.id,
    );
    assert.equal(runs.length, 1);
    await target.stop();
  });
});

describe("un nodo webhook que espera en A, llamado por B", () => {
  test("la llamada que entra por B despierta a A por el bus, sin esperar al sondeo", async () => {
    const { target, projectBase, environmentId } = await project(0);
    const workflow = await on(a)
      .post(`${projectBase}/workflows`)
      .set(as(owner))
      .send({
        name: "Espera un pago",
        definition: {
          steps: [
            {
              id: "pago",
              kind: "webhook",
              webhook: { timeoutMs: 20_000 },
              checks: [{ source: "body", path: "status", operator: "equals", value: "paid" }],
            },
          ],
        },
      });
    assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
    const started = await on(a)
      .post(`${projectBase}/runs`)
      .set(as(owner))
      .send({ environmentId, workflowId: workflow.body.workflowId });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runPath = `${projectBase}/runs/${started.body.runId}`;

    // La URL la calcula B, que no tiene la corrida: sale de la tabla y de la clave compartida.
    let url = "";
    for (let tries = 0; !url && tries < 100; tries++) {
      const view = await on(b).get(runPath).set(as(owner));
      url = (view.body.hooks as { url: string }[] | undefined)?.[0]?.url ?? "";
      if (!url) await settle();
    }
    const token = /\/hooks\/flows\/([A-Za-z0-9_-]{43})$/.exec(url)?.[1];
    assert.ok(token, `B no enseñó la URL: ${url}`);

    const calledAt = Date.now();
    const delivered = await on(b).post(`/hooks/flows/${token}`).send({ status: "paid" });
    assert.equal(delivered.status, 202, JSON.stringify(delivered.body));
    await a.queue.idle();
    // El sondeo de la tabla es de un segundo: acabar mucho antes es que el aviso llegó por el bus.
    assert.ok(Date.now() - calledAt < 700, `A tardó ${Date.now() - calledAt} ms en enterarse`);

    const run = await on(b).get(runPath).set(as(owner));
    assert.equal(run.body.status, "passed", JSON.stringify(run.body.cases));
    // Y la misma URL, otra vez y por la otra instancia, ya no existe.
    const again = await on(a).post(`/hooks/flows/${token}`).send({ status: "paid" });
    assert.equal(again.status, 404);
    await target.stop();
  });
});

describe("pruebas de carga lanzadas por las dos instancias a la vez", () => {
  test("corre una sola: la otra espera a que termine la primera, y luego corre", async () => {
    const { target, projectBase, environmentId } = await project(0);
    const plan = await on(a)
      .post(`${projectBase}/performance/plans`)
      .set(as(owner))
      .send({
        name: "un segundo",
        definition: {
          scenarios: [
            { id: "leer", name: "Leer", weight: 1, thinkMs: 20, requests: [{ method: "GET", path: "/things" }] },
          ],
          profile: { type: "constant", vus: 1, durationS: 1 },
          thresholds: {},
        },
      });
    assert.equal(plan.status, 201, JSON.stringify(plan.body));
    const launch = (context: TestContext) =>
      on(context)
        .post(`${projectBase}/performance/plans/${plan.body.planId}/runs`)
        .set(as(owner))
        .send({ environmentId });
    const [fromA, fromB] = await Promise.all([launch(a), launch(b)]);
    assert.equal(fromA.status, 202, JSON.stringify(fromA.body));
    assert.equal(fromB.status, 202, JSON.stringify(fromB.body));

    // Mirando las dos filas hasta que acaban: nunca las dos «running» a la vez.
    const read = async (runId: string) =>
      (await on(a).get(`${projectBase}/performance/runs/${runId}`).set(as(owner))).body as { status: string };
    const ids = [fromA.body.runId as string, fromB.body.runId as string];
    const active = (status: string) => ["queued", "running"].includes(status);
    let overlapped = false;
    let waited = false;
    for (let tries = 0; tries < 400; tries += 1) {
      const [runA, runB] = await Promise.all(ids.map(read));
      if (runA.status === "running" && runB.status === "running") overlapped = true;
      if ([runA.status, runB.status].sort().join() === "queued,running") waited = true;
      if (!active(runA.status) && !active(runB.status)) break;
      await settle();
    }
    assert.equal(overlapped, false, "las dos cargas corrieron a la vez");
    assert.ok(waited, "no se vio a ninguna esperando mientras la otra corría");
    const final = await Promise.all(ids.map(read));
    assert.ok(
      final.every((run) => !active(run.status)),
      `alguna no terminó: ${JSON.stringify(final.map((run) => run.status))}`,
    );
    assert.equal(a.repositories.executionTurns.rows.size, 0, "quedaron filas en la fila de turnos");
    await target.stop();
  });
});
