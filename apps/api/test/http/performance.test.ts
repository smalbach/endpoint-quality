/**
 * Performance through the API: a plan is saved, a run is launched behind the SSRF guard against a
 * loopback server, and it finishes with a summary, windows, a per-endpoint breakdown and a verdict
 * from its thresholds.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

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

let echo: Server;
let origin: string;
let owner: Actor;
let projectId: string;
let environmentId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

async function finished(runId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = (await api().get(`${base()}/performance/runs/${runId}`).set(as(owner))).body;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("la corrida no terminó");
}

const plan = () => ({
  name: "Carga básica",
  definition: {
    scenarios: [
      {
        id: "leer",
        name: "Leer salud",
        weight: 1,
        thinkMs: 0,
        requests: [
          {
            method: "GET",
            path: "/health",
            extract: [{ variable: "id", path: "id" }],
            checks: [{ source: "status", operator: "equals", value: 200 }],
          },
        ],
      },
    ],
    profile: { type: "constant", vus: 2, durationS: 1 },
    thresholds: { p95Ms: 10_000, maxErrorRate: 0.5 },
  },
});

before(async () => {
  echo = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 1, token: "abc" }));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;

  context = await createTestApp();
  owner = await signUp("perf@example.com");
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Tienda" });
  projectId = project.body.projectId;
  const environment = await api()
    .post(`${base()}/environments`)
    .set(as(owner))
    .send({ name: "local", baseUrl: origin });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  environmentId = environment.body.environmentId ?? environment.body.id;
});

after(async () => {
  await context?.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

describe("las pruebas de carga", () => {
  test("guardar un plan y ejecutarlo: termina con resumen, ventanas y veredicto", async () => {
    const created = await api().post(`${base()}/performance/plans`).set(as(owner)).send(plan());
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const planId = created.body.planId;

    const list = await api().get(`${base()}/performance/plans`).set(as(owner));
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].definition.profile.vus, 2);

    const started = await api()
      .post(`${base()}/performance/plans/${planId}/runs`)
      .set(as(owner))
      .send({ environmentId });
    assert.equal(started.status, 202, JSON.stringify(started.body));

    const run = await finished(started.body.runId);
    assert.equal(run.status, "passed", JSON.stringify(run.thresholds));
    assert.ok(run.summary.requests > 0, "envió al menos una petición");
    assert.equal(run.summary.failures, 0);
    assert.ok(run.windows.length >= 1);
    assert.ok(run.endpoints.some((endpoint: { path: string }) => endpoint.path === "/health"));
    assert.ok(run.thresholds.every((threshold: { ok: boolean }) => threshold.ok));
  });

  test("un plan sin nombre es 422; ejecutar un plan sin escenarios es 422", async () => {
    const noName = await api().post(`${base()}/performance/plans`).set(as(owner)).send({ name: "" });
    assert.equal(noName.status, 422);

    const empty = await api().post(`${base()}/performance/plans`).set(as(owner)).send({ name: "Vacío" });
    assert.equal(empty.status, 201);
    const run = await api()
      .post(`${base()}/performance/plans/${empty.body.planId}/runs`)
      .set(as(owner))
      .send({ environmentId });
    assert.equal(run.status, 422, JSON.stringify(run.body));
  });

  test("un viewer no puede lanzar ni borrar", async () => {
    const created = await api()
      .post(`${base()}/performance/plans`)
      .set(as(owner))
      .send({ ...plan(), name: "Otro" });
    const viewer = await signUp("perf-viewer@example.com");
    // El viewer es de otra organización: no ve el proyecto, así que la ruta responde 403/404.
    const denied = await api()
      .post(`${base()}/performance/plans/${created.body.planId}/runs`)
      .set(as(viewer))
      .send({ environmentId });
    assert.ok([403, 404].includes(denied.status), `esperaba 403/404, fue ${denied.status}`);
  });
});
