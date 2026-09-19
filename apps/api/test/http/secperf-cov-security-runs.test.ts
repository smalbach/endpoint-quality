/**
 * Security runs through the API, on the paths the happy-path suite does not walk: the refusals
 * (no environment, a foreign environment, a run in flight), the roles, the api-token launch, the
 * share link's lifecycle, the SSE stream, and the filters of the detail.
 *
 * Most runs here are seeded straight into the in-memory repository in the state a test needs —
 * «running» without a worker behind it is the only way to ask what cancel and delete do to one.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { normalizeSelection, type Finding, type ProbeResult } from "@eq/security-rules";

import { createTestApp, type TestContext } from "../support/test-app";
import type { SecurityRun } from "@/modules/security-runs/domain/model";
import { SECURITY_RUN_QUEUE } from "@/modules/security-runs/domain/ports";
import type { InMemorySecurityRunQueue } from "@/modules/security-runs/infrastructure/in-memory-security-queue";
import { SecurityRunProgressStream } from "@/modules/security-runs/infrastructure/security-run-progress.stream";

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

let echo: Server;
let origin: string;
let owner: Actor;
let viewer: Actor;
let projectId: string;
let bareProjectId: string;
let otherProjectId: string;
let foreignEnvironmentId: string;
let endpointId: string;
const base = (project = projectId) => `/orgs/${owner.organizationId}/projects/${project}`;

async function finished(runId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = (await api().get(`${base()}/security-runs/${runId}`).set(as(owner))).body;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("la corrida no terminó");
}

const finding = (overrides: Partial<Finding>): Finding => ({
  ruleKey: "cors",
  ruleId: "R",
  ruleName: "CORS",
  category: "config",
  severity: "low",
  endpointId: null,
  title: "t",
  detail: "d",
  remediation: "r",
  references: [],
  reproduce: [],
  evidence: {},
  ...overrides,
});

const probe = (overrides: Partial<ProbeResult>): ProbeResult => ({
  id: randomUUID(),
  endpointId: "ep",
  testType: "no-auth",
  method: "GET",
  path: "/x",
  credential: null,
  token: null,
  headers: {},
  body: null,
  contentType: null,
  note: "",
  status: 200,
  responseHeaders: {},
  bodyText: "",
  bodyBytes: 0,
  durationMs: 1,
  error: null,
  sentAuthorization: false,
  ...overrides,
});

/** A run in whatever state the test needs, stored without going through the queue. */
async function seed(overrides: Partial<SecurityRun> = {}): Promise<SecurityRun> {
  const run: SecurityRun = {
    id: randomUUID(),
    projectId,
    environmentId: randomUUID(),
    label: "Sembrada",
    status: "passed",
    rules: normalizeSelection(undefined),
    options: { rateLimitIterations: 20, requestTimeoutMs: 10000, crossUserPermutations: false, endpointIds: [], adminRole: null },
    progress: { phase: "Terminado", percentage: 100, detail: "", endpointsTested: 1, endpointsTotal: 1 },
    score: 90,
    risk: "low",
    summary: null,
    findings: [],
    probes: [],
    ai: null,
    visibility: "private",
    shareToken: null,
    triggeredByKind: "user",
    triggeredBy: owner.userId,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    finishedAt: new Date("2026-01-01T00:01:00Z"),
    error: null,
    ...overrides,
  };
  await context.repositories.securityRuns.save(run);
  return run;
}

/** Reads an SSE response to its end, as text. */
function sse(path: string, headers: Record<string, string> = {}) {
  return api()
    .get(path)
    .set(headers)
    .buffer(true)
    .parse((response, done) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString()));
      response.on("end", () => done(null, text));
    });
}

before(async () => {
  echo = createServer((_incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 1 }));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;

  context = await createTestApp();
  owner = await signUp("secperf-sec@example.com");
  viewer = await signUp("secperf-sec-viewer@example.com");
  await context.repositories.memberships.save({
    organizationId: owner.organizationId,
    userId: viewer.userId,
    role: "viewer",
    createdAt: new Date(),
  });

  const createProject = async (name: string) =>
    (await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name })).body.projectId as string;
  projectId = await createProject("Tienda");
  bareProjectId = await createProject("Sin entorno");
  otherProjectId = await createProject("Otro");

  const environment = await api().post(`${base()}/environments`).set(as(owner)).send({ name: "local", baseUrl: origin });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  const foreign = await api()
    .post(`${base(otherProjectId)}/environments`)
    .set(as(owner))
    .send({ name: "ajeno", baseUrl: origin });
  foreignEnvironmentId = foreign.body.environmentId ?? foreign.body.id;
  const created = await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "GET", path: "/items" });
  endpointId = created.body.endpointId ?? created.body.id;
});

after(async () => {
  await context?.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

describe("lanzar una corrida de seguridad: las negativas", () => {
  test("un proyecto sin entorno activo y sin environmentId es 422 environment-required", async () => {
    const response = await api().post(`${base(bareProjectId)}/security-runs`).set(as(owner)).send({});
    assert.equal(response.status, 422);
    assert.match(response.body.type, /environment-required$/);
  });

  test("un entorno que no existe, o que es de otro proyecto, es 404 environment-not-found", async () => {
    for (const environmentId of [randomUUID(), foreignEnvironmentId]) {
      const response = await api().post(`${base()}/security-runs`).set(as(owner)).send({ environmentId });
      assert.equal(response.status, 404, environmentId);
      assert.match(response.body.type, /environment-not-found$/);
    }
    assert.equal(context.repositories.securityRuns.rows.size, 0, "no se guardó ninguna corrida");
  });

  test("un viewer lee pero no lanza: 403 insufficient-role", async () => {
    const response = await api().post(`${base()}/security-runs`).set(as(viewer)).send({});
    assert.equal(response.status, 403);
    assert.match(response.body.type, /insufficient-role$/);
    assert.equal((await api().get(`${base()}/security-runs`).set(as(viewer))).status, 200);
  });
});

describe("lanzar una corrida de seguridad: lo que se guarda", () => {
  test("las opciones enviadas se guardan tal cual; una etiqueta en blanco toma la fecha", async () => {
    const started = await api()
      .post(`${base()}/security-runs`)
      .set(as(owner))
      .send({
        label: "   ",
        rateLimitIterations: 7,
        requestTimeoutMs: 2500,
        crossUserPermutations: true,
        endpointIds: [endpointId],
        adminRole: "admin",
        rules: { cors: false },
      });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const run = await finished(started.body.runId);
    assert.match(run.label, /^Corrida /);
    assert.deepEqual(run.options, {
      rateLimitIterations: 7,
      requestTimeoutMs: 2500,
      crossUserPermutations: true,
      endpointIds: [endpointId],
      adminRole: "admin",
    });
    assert.equal(run.rules.cors, false);
    assert.equal(run.rules.auth_jwt, true, "lo no enviado toma la selección recomendada");
    assert.equal(run.triggeredByKind, "user");
    assert.equal(run.triggeredBy, owner.userId);
  });

  test("lanzada con un token de servicio, queda a nombre del token", async () => {
    const minted = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI" });
    assert.equal(minted.status, 201);
    const started = await api()
      .post(`${base()}/security-runs`)
      .set({ Authorization: `Bearer ${minted.body.token}` })
      .send({ label: "Desde CI" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const run = await finished(started.body.runId);
    assert.equal(run.triggeredByKind, "api-token");
    assert.notEqual(run.triggeredBy, owner.userId);
    assert.equal(run.label, "Desde CI");
  });

  test("la lista respeta el límite pedido y trae la más reciente primero", async () => {
    await seed({ label: "Vieja", startedAt: new Date("2020-01-01T00:00:00Z") });
    const one = await api().get(`${base()}/security-runs?limit=1`).set(as(owner));
    assert.equal(one.status, 200);
    assert.equal(one.body.length, 1);
    assert.notEqual(one.body[0].label, "Vieja");
    const all = await api().get(`${base()}/security-runs?limit=abc`).set(as(owner));
    assert.ok(all.body.length >= 3);
    assert.equal(all.body.at(-1).label, "Vieja");
  });
});

describe("una corrida en curso", () => {
  test("cancelarla la marca en la cola; cancelar una terminada no marca nada", async () => {
    const queue = context.app.get<InMemorySecurityRunQueue>(SECURITY_RUN_QUEUE);
    const running = await seed({ status: "running", finishedAt: null });
    const queued = await seed({ status: "queued", finishedAt: null });
    const done = await seed({ status: "failed" });

    for (const run of [running, queued, done]) {
      const response = await api().post(`${base()}/security-runs/${run.id}/cancel`).set(as(owner));
      assert.equal(response.status, 204);
    }
    assert.equal(queue.isCancelled(running.id), true);
    assert.equal(queue.isCancelled(queued.id), true);
    assert.equal(queue.isCancelled(done.id), false);
  });

  test("no se borra ni se analiza hasta que termine: 409 run-in-progress", async () => {
    for (const status of ["running", "queued"] as const) {
      const run = await seed({ status, finishedAt: null });
      const removed = await api().delete(`${base()}/security-runs/${run.id}`).set(as(owner));
      assert.equal(removed.status, 409, status);
      assert.match(removed.body.type, /run-in-progress$/);
      const analyzed = await api().post(`${base()}/security-runs/${run.id}/ai`).set(as(owner));
      assert.equal(analyzed.status, 409, status);
      assert.ok(context.repositories.securityRuns.rows.has(run.id));
      assert.equal(context.repositories.securityRuns.rows.get(run.id)!.ai, null);
    }
  });

  test("una corrida pedida desde otro proyecto de la misma organización no existe", async () => {
    const run = await seed({});
    for (const [method, path] of [
      ["get", ""],
      ["post", "/cancel"],
      ["delete", ""],
      ["post", "/ai"],
      ["get", "/report"],
    ] as const) {
      const response = await api()[method](`${base(otherProjectId)}/security-runs/${run.id}${path}`).set(as(owner));
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.match(response.body.type, /security-run-not-found$/);
    }
    const patched = await api()
      .patch(`${base(otherProjectId)}/security-runs/${run.id}/visibility`)
      .set(as(owner))
      .send({ visibility: "public" });
    assert.equal(patched.status, 404);
    assert.equal(context.repositories.securityRuns.rows.get(run.id)!.visibility, "private");
  });
});

describe("el detalle, el informe y el enlace compartido", () => {
  let filtered: SecurityRun;
  before(async () => {
    filtered = await seed({
      label: "Filtrable",
      findings: [
        finding({ ruleKey: "cors", severity: "low", endpointId: "a" }),
        finding({ ruleKey: "auth_jwt", severity: "critical", endpointId: "b" }),
      ],
      probes: [
        probe({ endpointId: "a", method: "GET", testType: "no-auth", status: 200 }),
        probe({ endpointId: "a", method: "POST", testType: "injection:sql", status: 500 }),
        probe({ endpointId: "b", method: "GET", testType: "auth:admin", status: 404 }),
      ],
    });
  });

  test("los filtros del detalle llegan desde la query, con el método en mayúsculas", async () => {
    const get = (query: string) => api().get(`${base()}/security-runs/${filtered.id}?${query}`).set(as(owner));
    const byRule = await get("ruleKey=auth_jwt");
    assert.deepEqual(
      byRule.body.findings.map((entry: Finding) => entry.severity),
      ["critical"],
    );
    const byMethod = await get("method=post");
    assert.deepEqual(
      byMethod.body.probes.data.map((entry: ProbeResult) => entry.testType),
      ["injection:sql"],
    );
    const byFamily = await get("statusFamily=4&endpointId=b");
    assert.equal(byFamily.body.probes.total, 1);
    assert.equal(byFamily.body.findingsTotal, 1);
    const byType = await get("testType=injection&page=1&pageSize=10");
    assert.equal(byType.body.probes.total, 1);
    assert.equal(byType.body.probes.pageSize, 10);
  });

  test("el HTML del informe se sirve inline con un nombre de archivo", async () => {
    const html = await api().get(`${base()}/security-runs/${filtered.id}/report?format=html`).set(as(owner));
    assert.equal(html.status, 200);
    assert.equal(html.headers["content-disposition"], `inline; filename="seguridad-${filtered.id}.html"`);
    assert.match(html.text, /Filtrable/);
    // Sin formato: JSON, con el endpoint desconocido abreviado a su id.
    const json = await api().get(`${base()}/security-runs/${filtered.id}/report`).set(as(owner));
    assert.equal(json.status, 200);
    assert.match(json.headers["content-type"], /application\/json/);
    assert.deepEqual(
      json.body.findings.map((entry: { endpoint: string }) => entry.endpoint),
      ["a", "b"],
    );

    // Un endpoint del proyecto se nombra por método y ruta; un hallazgo de toda la corrida, con un guion.
    const labelled = await seed({
      findings: [finding({ endpointId }), finding({ endpointId: null }), finding({ endpointId: `${randomUUID()}` })],
    });
    const named = await api().get(`${base()}/security-runs/${labelled.id}/report?format=json`).set(as(owner));
    const endpoints = named.body.findings.map((entry: { endpoint: string }) => entry.endpoint);
    assert.equal(endpoints[0], "GET /items");
    assert.equal(endpoints[1], "—");
    assert.equal(endpoints[2].length, 8, "un id desconocido se abrevia a 8 caracteres");
  });

  test("el enlace compartido: el token se acuña una vez y sobrevive a privada→pública", async () => {
    const setVisibility = (visibility: string) =>
      api().patch(`${base()}/security-runs/${filtered.id}/visibility`).set(as(owner)).send({ visibility });

    const first = await setVisibility("public");
    assert.equal(first.status, 200);
    const token = first.body.shareToken;
    assert.ok(token);
    assert.equal((await setVisibility("public")).body.shareToken, token, "volver a publicar no cambia el token");

    const sharedJson = await api().get(`/shared/security-runs/${token}/report?format=json`);
    assert.equal(sharedJson.status, 200);
    assert.equal(sharedJson.body.label, "Filtrable");
    const sharedDetail = await api().get(`/shared/security-runs/${token}?severity=low`);
    assert.equal(sharedDetail.status, 200);
    assert.equal(sharedDetail.body.findingsTotal, 1);

    const closed = await setVisibility("private");
    assert.deepEqual(closed.body, { visibility: "private", shareToken: null });
    assert.equal(context.repositories.securityRuns.rows.get(filtered.id)!.shareToken, token, "el token se guarda");
    for (const path of [`/shared/security-runs/${token}`, `/shared/security-runs/${token}/report?format=html`]) {
      const response = await api().get(path);
      assert.equal(response.status, 404, path);
      assert.match(response.body.type, /security-run-not-found$/);
    }

    assert.equal((await setVisibility("public")).body.shareToken, token, "el enlace pegado vuelve a funcionar");
    assert.equal((await api().get(`/shared/security-runs/${token}`)).status, 200);
    assert.equal((await api().get(`/shared/security-runs/${randomUUID()}/report`)).status, 404);
  });

  test("un viewer no cambia la visibilidad", async () => {
    const response = await api()
      .patch(`${base()}/security-runs/${filtered.id}/visibility`)
      .set(as(viewer))
      .send({ visibility: "public" });
    assert.equal(response.status, 403);
  });
});

describe("el progreso en vivo", () => {
  test("una corrida terminada: un solo evento finished con su puntuación, y el flujo se cierra", async () => {
    const run = await seed({ status: "failed", score: 40, risk: "high" });
    const stream = await sse(`${base()}/security-runs/${run.id}/stream`, as(owner));
    assert.equal(stream.status, 200);
    const text = String(stream.body);
    assert.equal(text.match(/event: finished/g)?.length, 1);
    assert.match(text, /"score":40/);
    assert.match(text, /"status":"failed"/);
    assert.doesNotMatch(text, /event: progress/);
  });

  test("una corrida en curso: primero el estado actual, después lo que se publica, hasta finished", async () => {
    const run = await seed({ status: "running", finishedAt: null });
    const progress = context.app.get(SecurityRunProgressStream);
    const following = sse(`${base()}/security-runs/${run.id}/stream`, as(owner));
    // Publish until the follower has subscribed and the stream closes.
    let closed = false;
    const publisher = (async () => {
      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        progress.publish(run.id, {
          type: "finished",
          status: "passed",
          progress: { phase: "Terminado", percentage: 100, detail: "", endpointsTested: 1, endpointsTotal: 1 },
          score: 99,
          risk: "low",
        });
      }
    })();
    const stream = await following;
    closed = true;
    await publisher;
    const text = String(stream.body);
    assert.match(text, /event: progress[\s\S]*"status":"running"/);
    assert.match(text, /event: finished[\s\S]*"score":99/);
    assert.ok(text.indexOf("event: progress") < text.indexOf("event: finished"));
  });

  test("el flujo de una corrida ajena es 404", async () => {
    const response = await api().get(`${base()}/security-runs/${randomUUID()}/stream`).set(as(owner));
    assert.equal(response.status, 404);
  });
});
