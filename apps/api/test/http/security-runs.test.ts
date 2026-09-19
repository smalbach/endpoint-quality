/**
 * Security runs through the API: launched, executed behind the SSRF guard against a loopback echo
 * server, judged, and shared.
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
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

/** Waits for a run to reach a terminal state, polling its detail. */
async function finished(runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = (await api().get(`${base()}/security-runs/${runId}`).set(as(owner))).body;
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("la corrida no terminó");
}

before(async () => {
  // Answers 200 to everything, so an endpoint that requires auth appears unprotected — the finding.
  // It also repeats the Authorization it got, like httpbin: a secret that comes back in the body.
  echo = createServer((incoming, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const seen = incoming.headers.authorization ? { seen: incoming.headers.authorization } : {};
    response.end(JSON.stringify({ id: 1, email: "a@b.c", items: [{ id: 1 }], ...seen }));
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;

  context = await createTestApp();
  owner = await signUp("sec@example.com");
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Tienda" });
  projectId = project.body.projectId;
  const environment = await api()
    .post(`${base()}/environments`)
    .set(as(owner))
    .send({ name: "local", baseUrl: origin, authEnforced: true });
  assert.equal(environment.status, 201, JSON.stringify(environment.body));
  await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "GET", path: "/me", requiresAuth: true });
});

after(async () => {
  await context?.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

describe("las corridas de seguridad", () => {
  test("lanzar responde 202 y un id; la corrida termina con hallazgos y puntuación", async () => {
    const started = await api().post(`${base()}/security-runs`).set(as(owner)).send({ label: "Primera" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const run = await finished(started.body.runId);

    assert.equal(run.status, "failed");
    assert.ok(run.score < 100);
    assert.equal(run.risk, "critical");
    // /me requiere auth y el eco responde 200 sin token: endpoint sin proteger.
    assert.equal(run.summary.unprotected.length, 1);
    assert.ok(run.findings.some((finding: { ruleKey: string }) => finding.ruleKey === "auth_jwt"));
    // Las sondas se guardaron y el token nunca viaja en claro en el eco.
    assert.ok(run.probes.total >= 1);
    assert.ok(run.probes.data.some((probe: { testType: string }) => probe.testType === "no-auth"));
  });

  test("filtra hallazgos por severidad y pagina las sondas", async () => {
    const started = await api().post(`${base()}/security-runs`).set(as(owner)).send({});
    const run = await finished(started.body.runId);
    const filtered = await api().get(`${base()}/security-runs/${run.id}?severity=critical&pageSize=1`).set(as(owner));
    assert.ok(filtered.body.findings.every((finding: { severity: string }) => finding.severity === "critical"));
    assert.equal(filtered.body.probes.data.length, 1);
    assert.ok(filtered.body.probes.total > 1);
  });

  test("la lista trae solo la cabecera, no las sondas", async () => {
    const list = await api().get(`${base()}/security-runs`).set(as(owner));
    assert.ok(list.body.length >= 2);
    assert.equal(list.body[0].probes, undefined);
    assert.ok(["passed", "failed", "cancelled", "error"].includes(list.body[0].status));
  });

  test("hacerla pública da un enlace que se lee sin sesión, y volverla privada lo cierra", async () => {
    const started = await api().post(`${base()}/security-runs`).set(as(owner)).send({});
    const run = await finished(started.body.runId);

    const shared = await api()
      .patch(`${base()}/security-runs/${run.id}/visibility`)
      .set(as(owner))
      .send({ visibility: "public" });
    assert.equal(shared.body.visibility, "public");
    const token = shared.body.shareToken;
    assert.ok(token);

    const publicRead = await api().get(`/shared/security-runs/${token}`);
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.body.id, run.id);

    await api().patch(`${base()}/security-runs/${run.id}/visibility`).set(as(owner)).send({ visibility: "private" });
    const closed = await api().get(`/shared/security-runs/${token}`);
    assert.equal(closed.status, 404);
  });

  test("el informe sale en JSON y en HTML imprimible, y el análisis se guarda", async () => {
    const started = await api().post(`${base()}/security-runs`).set(as(owner)).send({});
    const run = await finished(started.body.runId);

    const json = await api().get(`${base()}/security-runs/${run.id}/report?format=json`).set(as(owner));
    assert.equal(json.status, 200);
    assert.equal(json.body.label, run.label);
    assert.ok(Array.isArray(json.body.findings));

    const html = await api().get(`${base()}/security-runs/${run.id}/report?format=html`).set(as(owner));
    assert.equal(html.status, 200);
    assert.match(html.headers["content-type"], /text\/html/);
    assert.match(html.text, /Informe de seguridad/);

    // Sin clave de IA: análisis determinista, siempre disponible.
    const ai = await api().post(`${base()}/security-runs/${run.id}/ai`).set(as(owner));
    assert.equal(ai.status, 201);
    assert.ok(ai.body.ai.executiveSummary.length > 0);
    const withAi = await api().get(`${base()}/security-runs/${run.id}`).set(as(owner));
    assert.ok(withAi.body.ai.executiveSummary.length > 0);

    // El informe compartido se lee sin sesión.
    const shared = await api()
      .patch(`${base()}/security-runs/${run.id}/visibility`)
      .set(as(owner))
      .send({ visibility: "public" });
    const report = await api().get(`/shared/security-runs/${shared.body.shareToken}/report?format=html`);
    assert.equal(report.status, 200);
    assert.match(report.text, /Informe de seguridad/);
  });

  test("borrar una corrida terminada la quita; otra organización no la ve", async () => {
    const started = await api().post(`${base()}/security-runs`).set(as(owner)).send({});
    const run = await finished(started.body.runId);
    const removed = await api().delete(`${base()}/security-runs/${run.id}`).set(as(owner));
    assert.equal(removed.status, 204);
    assert.equal((await api().get(`${base()}/security-runs/${run.id}`).set(as(owner))).status, 404);

    const outsider = await signUp("sec-ajeno@example.com");
    const denied = await api()
      .get(`/orgs/${outsider.organizationId}/projects/${projectId}/security-runs`)
      .set(as(outsider));
    assert.equal(denied.status, 404);
  });
});

describe("el token del entorno", () => {
  const segment = (object: unknown) => Buffer.from(JSON.stringify(object)).toString("base64url");
  const signature = "firma-que-no-se-guarda-7";
  // Sin firmar de verdad y sin exp: justo lo que las comprobaciones de auth_jwt buscan.
  const token = `${segment({ alg: "none", typ: "JWT" })}.${segment({ sub: "42", role: "admin" })}.${signature}`;

  test("las reglas leen el token real (alg: none, sin exp) y lo guardado lo lleva tapado", async () => {
    const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "JWT" });
    const projectBase = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
    const environment = await api()
      .post(`${projectBase}/environments`)
      .set(as(owner))
      .send({ name: "local", baseUrl: origin, authEnforced: true });
    await api()
      .post(`${projectBase}/endpoints`)
      .set(as(owner))
      .send({ method: "GET", path: "/me", requiresAuth: true });
    assert.equal((await api().post(`${projectBase}/roles`).set(as(owner)).send({ name: "admin" })).status, 201);
    const credential = await api()
      .put(`${projectBase}/environments/${environment.body.environmentId}/credentials`)
      .set(as(owner))
      .send({ name: "admin", role: "admin", kind: "bearer", secret: token });
    assert.equal(credential.status, 200, JSON.stringify(credential.body));

    const started = await api().post(`${projectBase}/security-runs`).set(as(owner)).send({ adminRole: "admin" });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    let run: { status: string; findings: { ruleKey: string; title: string }[] } | undefined;
    for (let attempt = 0; attempt < 200 && (!run || ["queued", "running"].includes(run.status)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      run = (await api().get(`${projectBase}/security-runs/${started.body.runId}?pageSize=200`).set(as(owner))).body;
    }
    assert.ok(run && !["queued", "running"].includes(run.status), "la corrida no terminó");

    // El token de verdad salió hacia el objetivo…
    assert.ok(context.http.calls.some((call) => call.headers.authorization === `Bearer ${token}`));
    // …y las reglas lo juzgaron: antes veían «••••••••» y estas dos no saltaban nunca.
    const jwt = run.findings.filter((finding) => finding.ruleKey === "auth_jwt").map((finding) => finding.title);
    assert.ok(jwt.includes("El token viaja con alg: none"), JSON.stringify(jwt));
    assert.ok(jwt.includes("El token no caduca"), JSON.stringify(jwt));

    // Lo guardado y lo devuelto: la cabecera tapada, y el token ni entero, ni desnudo, ni su firma
    // (que los tokens falsificados de jwt-attack conservan), tampoco en el cuerpo que el eco repitió.
    const stored = await context.repositories.securityRuns.findById(started.body.runId);
    assert.ok(stored);
    const auth = stored.probes.find((probe) => probe.testType === "auth:admin");
    assert.ok(auth);
    assert.equal(auth.headers.Authorization, "••••••••");
    assert.match(auth.bodyText, /"seen":"••••••••"/);
    const returned = (await api().get(`${projectBase}/security-runs/${started.body.runId}?pageSize=200`).set(as(owner)))
      .text;
    for (const text of [JSON.stringify(stored), returned]) {
      assert.ok(!text.includes(token));
      assert.ok(!text.includes(signature));
    }
  });
});
