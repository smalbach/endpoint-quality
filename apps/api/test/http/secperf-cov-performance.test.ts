/**
 * Performance through the API, beyond the happy path: the plan's whole lifecycle with its
 * refusals (a taken name, an invalid definition, a missing plan), who is recorded as its author,
 * launching against the wrong environment, cancelling and deleting runs, and the live stream.
 *
 * Runs in a given state are seeded straight into the repository: a «running» one without a worker
 * is how cancel is asked about without racing a real load.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";
import type { PerformancePlanDefinition, PerformanceRun } from "@/modules/performance/domain/model";
import { PERFORMANCE_RUN_QUEUE } from "@/modules/performance/domain/ports";
import type { InMemoryPerformanceRunQueue } from "@/modules/performance/infrastructure/in-memory-performance-queue";
import { PerformanceProgressStream } from "@/modules/performance/infrastructure/performance-progress.stream";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { userId: registered.body.userId, organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let viewer: Actor;
let ciToken: string;
let projectId: string;
let otherProjectId: string;
let environmentId: string;
let foreignEnvironmentId: string;
const base = (project = projectId) => `/orgs/${owner.organizationId}/projects/${project}/performance`;

const definition = (): PerformancePlanDefinition => ({
  scenarios: [{ id: "s", name: "Leer", weight: 1, thinkMs: 0, requests: [{ method: "GET", path: "/health" }] }],
  profile: { type: "constant", vus: 1, durationS: 1 },
  thresholds: {},
});

async function createPlan(name: string, body: Record<string, unknown> = {}) {
  const response = await api().post(`${base()}/plans`).set(as(owner)).send({ name, ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.planId as string;
}

async function seedRun(overrides: Partial<PerformanceRun> = {}): Promise<PerformanceRun> {
  const run: PerformanceRun = {
    id: randomUUID(),
    projectId,
    planId: randomUUID(),
    planName: "Sembrado",
    environmentId,
    status: "passed",
    definition: definition(),
    progress: { elapsedS: 1, totalS: 1, requests: 3, vus: 0 },
    summary: null,
    windows: [],
    endpoints: [],
    thresholds: [],
    error: null,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    finishedAt: new Date("2026-01-01T00:00:01Z"),
    ...overrides,
  };
  await context.repositories.performanceRuns.save(run);
  return run;
}

function sse(path: string) {
  return api()
    .get(path)
    .set(as(owner))
    .buffer(true)
    .parse((response, done) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString()));
      response.on("end", () => done(null, text));
    });
}

before(async () => {
  context = await createTestApp();
  owner = await signUp("secperf-perf@example.com");
  viewer = await signUp("secperf-perf-viewer@example.com");
  await context.repositories.memberships.save({
    organizationId: owner.organizationId,
    userId: viewer.userId,
    role: "viewer",
    createdAt: new Date(),
  });
  ciToken = (await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI" })).body.token;

  const project = async (name: string) =>
    (await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name })).body.projectId as string;
  projectId = await project("Carga");
  otherProjectId = await project("Otra carga");
  const env = async (project: string) => {
    const created = await api()
      .post(`/orgs/${owner.organizationId}/projects/${project}/environments`)
      .set(as(owner))
      .send({ name: "local", baseUrl: "http://127.0.0.1:9" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return (created.body.environmentId ?? created.body.id) as string;
  };
  environmentId = await env(projectId);
  foreignEnvironmentId = await env(otherProjectId);
});

after(async () => {
  await context?.close();
});

describe("los planes de carga", () => {
  test("un nombre repetido es 409; una definición inválida es 422 con el campo que falla", async () => {
    await createPlan("Único");
    const taken = await api().post(`${base()}/plans`).set(as(owner)).send({ name: "Único" });
    assert.equal(taken.status, 409);
    assert.match(taken.body.type, /performance-plan-name-taken$/);

    const invalid = await api()
      .post(`${base()}/plans`)
      .set(as(owner))
      .send({ name: "Roto", definition: { ...definition(), profile: { type: "constant", vus: 0, durationS: 1 } } });
    assert.equal(invalid.status, 422);
    assert.match(invalid.body.type, /performance-plan-invalid$/);
    assert.ok(JSON.stringify(invalid.body).includes("profile.vus"), JSON.stringify(invalid.body));

    const blank = await api().post(`${base()}/plans`).set(as(owner)).send({ name: "   " });
    assert.equal(blank.status, 422);
    assert.match(blank.body.type, /performance-plan-invalid$/);
  });

  test("leer un plan: el borrador vacío lleva el perfil por omisión; uno que no existe es 404", async () => {
    const planId = await createPlan("Borrador", { description: "" });
    const read = await api().get(`${base()}/plans/${planId}`).set(as(owner));
    assert.equal(read.status, 200);
    assert.equal(read.body.name, "Borrador");
    assert.equal(read.body.description, null, "una descripción vacía se guarda como null");
    assert.deepEqual(read.body.definition, {
      scenarios: [],
      profile: { type: "constant", vus: 1, durationS: 30 },
      thresholds: {},
    });

    const missing = await api().get(`${base()}/plans/${randomUUID()}`).set(as(owner));
    assert.equal(missing.status, 404);
    assert.match(missing.body.type, /performance-plan-not-found$/);
    // Un plan de otro proyecto de la misma organización tampoco se ve.
    assert.equal((await api().get(`${base(otherProjectId)}/plans/${planId}`).set(as(owner))).status, 404);
  });

  test("editar: renombrar a un nombre ajeno es 409; al propio no; lo no enviado se conserva", async () => {
    await createPlan("Ocupado");
    const planId = await createPlan("Editable", { description: "Primera", definition: definition() });
    const put = (body: Record<string, unknown>, headers = as(owner)) =>
      api().put(`${base()}/plans/${planId}`).set(headers).send(body);
    const stored = () => context.repositories.performancePlans.rows.get(planId)!;

    const clash = await put({ name: "Ocupado" });
    assert.equal(clash.status, 409);
    assert.match(clash.body.type, /performance-plan-name-taken$/);
    assert.equal(stored().name, "Editable");

    assert.equal((await put({ name: "Editable" })).status, 204);
    assert.equal((await put({})).status, 204);
    assert.equal(stored().name, "Editable");
    assert.equal(stored().description, "Primera", "sin description, se queda la de antes");
    assert.deepEqual(stored().definition, definition());
    assert.equal(stored().updatedBy, owner.userId);

    assert.equal((await put({ description: "" })).status, 204);
    assert.equal(stored().description, null);

    const invalid = await put({ definition: { ...definition(), scenarios: [{ ...definition().scenarios[0], requests: [] }] } });
    assert.equal(invalid.status, 422);
    assert.match(invalid.body.type, /performance-plan-invalid$/);

    const changed = { ...definition(), thresholds: { p95Ms: 300 } };
    assert.equal((await put({ name: "  Renombrado  ", definition: changed })).status, 204);
    assert.equal(stored().name, "Renombrado");
    assert.deepEqual(stored().definition.thresholds, { p95Ms: 300 });

    // Con un token de servicio, el autor es el token.
    assert.equal((await put({ description: "Desde CI" }, { Authorization: `Bearer ${ciToken}` })).status, 204);
    assert.notEqual(stored().updatedBy, owner.userId);
    assert.ok(stored().updatedBy);

    const missing = await api().put(`${base()}/plans/${randomUUID()}`).set(as(owner)).send({ name: "x" });
    assert.equal(missing.status, 404);
  });

  test("un plan creado con token de servicio queda a nombre del token", async () => {
    const created = await api()
      .post(`${base()}/plans`)
      .set({ Authorization: `Bearer ${ciToken}` })
      .send({ name: "De CI" });
    assert.equal(created.status, 201);
    const plan = context.repositories.performancePlans.rows.get(created.body.planId)!;
    assert.notEqual(plan.updatedBy, owner.userId);
  });

  test("borrar un plan lo saca de la lista y se puede restaurar; sus corridas se quedan igual", async () => {
    const planId = await createPlan("Efímero", { definition: definition() });
    const kept = await seedRun({ planId, planName: "Efímero" });
    const removed = await api().delete(`${base()}/plans/${planId}`).set(as(owner));
    assert.equal(removed.status, 204);

    // Fuera de la lista de planes, dentro de la papelera, y legible: es lo que dice si merece la
    // pena restaurarlo.
    const live = await api().get(`${base()}/plans`).set(as(owner));
    assert.ok(!live.body.some((plan: { id: string }) => plan.id === planId));
    const trash = await api().get(`${base()}/plans?state=deleted`).set(as(owner));
    assert.deepEqual(
      trash.body.map((plan: { id: string }) => plan.id),
      [planId],
    );
    assert.equal((await api().get(`${base()}/plans/${planId}`).set(as(owner))).status, 200);
    // Borrarlo dos veces es la misma operación ya hecha, no un error.
    assert.equal((await api().delete(`${base()}/plans/${planId}`).set(as(owner))).status, 204);

    // El nombre quedó libre mientras estaba fuera: si se reutiliza, restaurar es un 409.
    const otherId = await createPlan("Efímero", { definition: definition() });
    assert.equal((await api().post(`${base()}/plans/${planId}/restore`).set(as(owner))).status, 409);
    assert.equal((await api().delete(`${base()}/plans/${otherId}`).set(as(owner))).status, 204);
    assert.equal((await api().post(`${base()}/plans/${planId}/restore`).set(as(owner))).status, 204);

    // Archivar lo saca de la lista de trabajo sin borrarlo.
    const filed = await api().patch(`${base()}/plans/${planId}/archived`).set(as(owner)).send({ archived: true });
    assert.equal(filed.status, 204);
    const archived = await api().get(`${base()}/plans?state=archived`).set(as(owner));
    assert.deepEqual(
      archived.body.map((plan: { id: string }) => plan.id),
      [planId],
    );
    await api().patch(`${base()}/plans/${planId}/archived`).set(as(owner)).send({ archived: false });

    // El definitivo pide que antes esté eliminado.
    assert.equal((await api().delete(`${base()}/plans/${planId}?purge=true`).set(as(owner))).status, 409);
    await api().delete(`${base()}/plans/${planId}`).set(as(owner));
    assert.equal((await api().delete(`${base()}/plans/${planId}?purge=true`).set(as(owner))).status, 204);
    assert.equal((await api().get(`${base()}/plans/${planId}`).set(as(owner))).status, 404);

    // Y la corrida sigue ahí, con el plan que midió dentro.
    const runs = await api().get(`${base()}/runs?planId=${planId}`).set(as(owner));
    assert.equal(runs.status, 200);
    assert.deepEqual(
      runs.body.map((entry: { id: string }) => entry.id),
      [kept.id],
    );
  });

  test("un viewer lee los planes pero no los escribe", async () => {
    assert.equal((await api().get(`${base()}/plans`).set(as(viewer))).status, 200);
    const denied = await api().post(`${base()}/plans`).set(as(viewer)).send({ name: "Del viewer" });
    assert.equal(denied.status, 403);
    assert.match(denied.body.type, /insufficient-role$/);
  });
});

describe("lanzar una corrida de carga: las negativas", () => {
  test("un entorno que no existe o de otro proyecto es 422 environment-invalid", async () => {
    const planId = await createPlan("Con escenario", { definition: definition() });
    for (const target of [randomUUID(), foreignEnvironmentId]) {
      const response = await api().post(`${base()}/plans/${planId}/runs`).set(as(owner)).send({ environmentId: target });
      assert.equal(response.status, 422, target);
      assert.match(response.body.type, /environment-invalid$/);
    }
    assert.equal(
      (await api().get(`${base()}/runs?planId=${planId}`).set(as(owner))).body.length,
      0,
      "no se creó ninguna corrida",
    );
  });

  test("un plan guardado con una definición que ya no es válida no se ejecuta: 422", async () => {
    const planId = await createPlan("Envejecido", { definition: definition() });
    const row = context.repositories.performancePlans.rows.get(planId)!;
    await context.repositories.performancePlans.save({
      ...row,
      definition: { ...row.definition, profile: { type: "constant", vus: 100_000, durationS: 1 } },
    });
    const response = await api().post(`${base()}/plans/${planId}/runs`).set(as(owner)).send({ environmentId });
    assert.equal(response.status, 422);
    assert.match(response.body.type, /performance-plan-invalid$/);
  });

  test("un plan que no existe es 404", async () => {
    const response = await api().post(`${base()}/plans/${randomUUID()}/runs`).set(as(owner)).send({ environmentId });
    assert.equal(response.status, 404);
    assert.match(response.body.type, /performance-plan-not-found$/);
  });
});

describe("las corridas de carga", () => {
  test("cancelar marca en la cola solo las que están en curso", async () => {
    const queue = context.app.get<InMemoryPerformanceRunQueue>(PERFORMANCE_RUN_QUEUE);
    const running = await seedRun({ status: "running", finishedAt: null });
    const queued = await seedRun({ status: "queued", finishedAt: null });
    const done = await seedRun({ status: "failed" });
    for (const run of [running, queued, done])
      assert.equal((await api().post(`${base()}/runs/${run.id}/cancel`).set(as(owner))).status, 204);
    assert.equal(queue.isCancelled(running.id), true);
    assert.equal(queue.isCancelled(queued.id), true);
    assert.equal(queue.isCancelled(done.id), false);

    const missing = await api().post(`${base()}/runs/${randomUUID()}/cancel`).set(as(owner));
    assert.equal(missing.status, 404);
    assert.match(missing.body.type, /performance-run-not-found$/);
  });

  test("borrar una corrida la quita; otra vez es 404; y desde otro proyecto no existe", async () => {
    const run = await seedRun({});
    assert.equal((await api().delete(`${base(otherProjectId)}/runs/${run.id}`).set(as(owner))).status, 404);
    assert.ok(context.repositories.performanceRuns.rows.has(run.id));

    assert.equal((await api().delete(`${base()}/runs/${run.id}`).set(as(owner))).status, 204);
    assert.equal(context.repositories.performanceRuns.rows.has(run.id), false);
    const again = await api().get(`${base()}/runs/${run.id}`).set(as(owner));
    assert.equal(again.status, 404);
    assert.match(again.body.type, /performance-run-not-found$/);
    assert.equal((await api().delete(`${base()}/runs/${run.id}`).set(as(owner))).status, 404);
  });

  test("la lista sin plan trae todas, de la más reciente a la más vieja", async () => {
    const old = await seedRun({ startedAt: new Date("2020-01-01T00:00:00Z"), planName: "Antigua" });
    const list = await api().get(`${base()}/runs?planId=`).set(as(owner));
    assert.equal(list.status, 200);
    assert.ok(list.body.length >= 2);
    assert.equal(list.body.at(-1).id, old.id);
    assert.equal(list.body.at(-1).planName, "Antigua");
    assert.equal(list.body[0].definition, undefined, "la lista no trae la definición");
  });

  test("comparar con una base que no existe es 404", async () => {
    const target = await seedRun({});
    const response = await api().get(`${base()}/compare?base=${randomUUID()}&target=${target.id}`).set(as(owner));
    assert.equal(response.status, 404);
    assert.match(response.body.detail ?? response.body.title, /base/);
  });

  test("el flujo de una corrida terminada: un evento finished y se cierra", async () => {
    const run = await seedRun({ status: "cancelled" });
    const stream = await sse(`${base()}/runs/${run.id}/stream`);
    assert.equal(stream.status, 200);
    const text = String(stream.body);
    assert.equal(text.match(/event: finished/g)?.length, 1);
    assert.match(text, /"status":"cancelled"/);
  });

  test("el flujo de una corrida en curso: su estado y después lo publicado, hasta finished", async () => {
    const run = await seedRun({ status: "running", finishedAt: null });
    const progress = context.app.get(PerformanceProgressStream);
    const following = sse(`${base()}/runs/${run.id}/stream`);
    let closed = false;
    const publisher = (async () => {
      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        progress.publish({
          runId: run.id,
          type: "finished",
          status: "passed",
          progress: { elapsedS: 1, totalS: 1, requests: 9, vus: 0 },
        });
      }
    })();
    const stream = await following;
    closed = true;
    await publisher;
    const text = String(stream.body);
    assert.match(text, /event: progress[\s\S]*"status":"running"/);
    assert.match(text, /event: finished[\s\S]*"requests":9/);
  });
});
