/**
 * Un monitor que vigila un canal sin flujo.
 *
 * Lo que tiene que ser cierto: que la vuelta es una corrida de un caso que corre por el mismo camino
 * que el nodo `channel` —el mismo veredicto, la misma transcripción tapada—; que la racha y el aviso
 * funcionan como en cualquier otro monitor; y que el canal tiene que ser de este proyecto, al guardar
 * y en cada vuelta, porque puede borrarse después.
 */
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import { StubTarget, STUB_SPEC_YAML } from "../support/stub-target";

let context: TestContext;
let target: StubTarget;
const api = () => request(context.app.getHttpServer());

const SOCKET = "wss://eco.example.test/socket";
const TOKEN = "tk-monitor-canal-no-debe-salir-51c7";

type Actor = { organizationId: string; token: string };
let owner: Actor;
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}

async function project(withContract = true): Promise<{ base: string; environmentId: string }> {
  const created = await api()
    .post(`/orgs/${owner.organizationId}/projects`)
    .set(as(owner))
    .send({ name: `mon-canal-${Math.random().toString(36).slice(2, 8)}` });
  const base = `/orgs/${owner.organizationId}/projects/${created.body.projectId}`;
  if (withContract) {
    const imported = await api()
      .post(`${base}/spec-versions`)
      .set(as(owner))
      .send({ source: { kind: "inline", raw: STUB_SPEC_YAML } });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
  }
  const environment = await api()
    .post(`${base}/environments`)
    .set(as(owner))
    .send({
      name: "stub",
      baseUrl: target.origin,
      specUrl: `${target.origin}/openapi.json`,
      writesAllowed: true,
      authEnforced: false,
      variables: { wsBase: { initial: "wss://eco.example.test" }, token: { initial: TOKEN, sensitive: true } },
    });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  return { base, environmentId: environment.body.environmentId as string };
}

async function channel(base: string, expected = "ok"): Promise<{ id: string; name: string }> {
  const name = `canal-${Math.random().toString(36).slice(2, 8)}`;
  const created = await api()
    .post(`${base}/channels`)
    .set(as(owner))
    .send({
      name,
      url: "{{wsBase}}/socket",
      expectations: {
        minMessages: 1,
        checks: [{ source: "message", path: "type", operator: "equals", value: expected, match: { at: "last" } }],
      },
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.id as string, name };
}

async function monitor(base: string, plan: Record<string, unknown>) {
  return api()
    .post(`${base}/monitors`)
    .set(as(owner))
    .send({ name: `m-${Math.random().toString(36).slice(2, 8)}`, schedule: { kind: "interval", minutes: 60 }, plan });
}

async function runNow(base: string, monitorId: string) {
  const fired = await api().post(`${base}/monitors/${monitorId}/runs`).set(as(owner)).send({});
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  await context.queue.idle();
  return fired.body as { runId: string | null; outcome: string; note: string };
}

before(async () => {
  context = await createTestApp();
  target = new StubTarget({});
  await target.start();
  owner = await signUp(`monitor-canal-${Date.now()}@example.test`);
});

after(async () => {
  await context?.close();
  await target?.stop();
});

beforeEach(() => context.channels.reset());

afterEach(() => {
  context.repositories.monitors.rows.clear();
  context.repositories.monitors.executions.clear();
});

describe("un monitor de canal", () => {
  test("corre en un proyecto sin contrato: un canal no lee ninguna operación", async () => {
    context.channels.script(SOCKET, { reply: () => [JSON.stringify({ type: "ok" })] });
    const { base, environmentId } = await project(false);
    const socket = await channel(base);
    const created = await monitor(base, {
      environmentId,
      channel: { channelId: socket.id, messages: [{ action: "send", body: "hola" }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const before = context.http.requested.length;

    const fired = await runNow(base, created.body.id);
    assert.ok(fired.runId, JSON.stringify(fired));
    const run = await api().get(`${base}/runs/${fired.runId}`).set(as(owner));
    assert.equal(run.body.status, "passed", JSON.stringify(run.body));
    // Y sin contrato no hay nada que leer del objetivo: la corrida no pide su /openapi.json.
    assert.ok(
      !context.http.requested.slice(before).some((url) => url.endsWith("/openapi.json")),
      context.http.requested.slice(before).join(", "),
    );
  });

  test("lanza una corrida de un caso con el veredicto del canal, y el guion con variables", async () => {
    context.channels.script(SOCKET, { reply: (text) => [JSON.stringify({ type: "ok", echo: text })] });
    const { base, environmentId } = await project();
    const socket = await channel(base);
    const created = await monitor(base, {
      environmentId,
      channel: { channelId: socket.id, messages: [{ action: "send", body: '{"auth":"{{token}}"}' }] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.plan.channel.channelId, socket.id);

    const fired = await runNow(base, created.body.id);
    assert.ok(fired.runId);
    const run = await api().get(`${base}/runs/${fired.runId}`).set(as(owner));
    assert.equal(run.body.status, "passed", JSON.stringify(run.body));
    assert.deepEqual(run.body.source, { kind: "channel", channelId: socket.id, name: socket.name });
    assert.equal(run.body.cases.length, 1);
    assert.equal(run.body.cases[0].method, "WS");
    assert.equal(run.body.cases[0].path, `«${socket.name}»`);
    assert.deepEqual(JSON.parse(context.channels.sent[0]!.text), { auth: TOKEN });

    const [row] = (await api().get(`${base}/monitors`).set(as(owner))).body.monitors;
    assert.equal(row.recent[0].outcome, "passed");
    assert.ok(
      !JSON.stringify([...context.repositories.runs.steps.values()]).includes(TOKEN),
      "el token no se guarda en la corrida",
    );
  });

  test("un canal en rojo sube la racha como cualquier otro monitor", async () => {
    context.channels.script(SOCKET, { greeting: ['{"type":"hola"}'] });
    const { base, environmentId } = await project();
    const socket = await channel(base, "adiós");
    const created = await monitor(base, { environmentId, channel: { channelId: socket.id, messages: [] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    await runNow(base, created.body.id);
    await runNow(base, created.body.id);
    const [row] = (await api().get(`${base}/monitors`).set(as(owner))).body.monitors;
    assert.equal(row.recent[0].outcome, "failed");
    assert.equal(row.consecutiveFailures, 2);
  });

  test("el canal tiene que ser de este proyecto, y no se mezcla con un flujo", async () => {
    const mine = await project();
    const theirs = await project();
    const foreign = await channel(theirs.base);

    const other = await monitor(mine.base, { environmentId: mine.environmentId, channel: { channelId: foreign.id } });
    assert.equal(other.status, 422, JSON.stringify(other.body));
    assert.equal(other.body.errors?.[0]?.field, "plan.channel.channelId");

    const own = await channel(mine.base);
    const mixed = await monitor(mine.base, {
      environmentId: mine.environmentId,
      workflowId: "00000000-0000-4000-8000-000000000000",
      channel: { channelId: own.id },
    });
    assert.equal(mixed.status, 422, JSON.stringify(mixed.body));

    const badScript = await monitor(mine.base, {
      environmentId: mine.environmentId,
      channel: { channelId: own.id, messages: [{ action: "wait", messages: 0, timeoutMs: 10 }] },
    });
    assert.equal(badScript.status, 422, JSON.stringify(badScript.body));

    const created = await monitor(mine.base, { environmentId: mine.environmentId, channel: { channelId: own.id } });
    const edited = await api()
      .patch(`${mine.base}/monitors/${created.body.id}`)
      .set(as(owner))
      .send({ plan: { environmentId: mine.environmentId, channel: { channelId: foreign.id } } });
    assert.equal(edited.status, 422, JSON.stringify(edited.body));
  });

  test("un canal borrado después deja la vuelta en error con el motivo", async () => {
    const { base, environmentId } = await project();
    const socket = await channel(base);
    const created = await monitor(base, { environmentId, channel: { channelId: socket.id } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const removed = await api().delete(`${base}/channels/${socket.id}`).set(as(owner));
    assert.equal(removed.status, 204, JSON.stringify(removed.body));

    const fired = await runNow(base, created.body.id);
    assert.equal(fired.runId, null);
    assert.equal(fired.outcome, "error");
    assert.match(fired.note, /canal no existe/);
  });
});
