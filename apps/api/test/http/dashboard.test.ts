/**
 * Dashboard and history: org-level reads that aggregate across the modules.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let projectId: string;
const base = () => `/orgs/${owner.organizationId}/projects/${projectId}`;

before(async () => {
  context = await createTestApp();
  owner = await signUp("dash@example.com");
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "Tienda" });
  projectId = project.body.projectId;
  await api().post(`${base()}/endpoints`).set(as(owner)).send({ method: "GET", path: "/me", requiresAuth: true });
  // Un escaneo por subida, para que aparezca en el historial.
  await api()
    .post(`${base()}/code-scan/scans/upload`)
    .set(as(owner))
    .send({
      files: [{ path: "x.controller.ts", content: `@Controller("orders") export class C { @Get() a() {} }` }],
      prefix: "api",
    });
});

after(async () => {
  await context?.close();
});

describe("el dashboard", () => {
  test("agrega los proyectos de la organización con sus conteos", async () => {
    const dashboard = (await api().get(`/orgs/${owner.organizationId}/dashboard`).set(as(owner))).body;
    assert.equal(dashboard.totals.projects, 1);
    const project = dashboard.projects.find((row: { id: string }) => row.id === projectId);
    assert.ok(project, "el proyecto está");
    assert.equal(project.endpoints, 1);
    assert.equal(project.securityScore, null, "sin corrida de seguridad todavía");
    assert.ok(Array.isArray(project.trends.securityScores), "trae series de tendencia");
    assert.deepEqual(project.trends.passRates, [], "sin corridas todavía, series vacías");
  });
});

describe("el historial", () => {
  test("reúne los análisis de todos los módulos, con búsqueda y paginación", async () => {
    const history = (await api().get(`/orgs/${owner.organizationId}/history`).set(as(owner))).body;
    assert.ok(history.total >= 1);
    assert.ok(history.entries.some((entry: { kind: string }) => entry.kind === "scan"));

    // Filtro por tipo.
    const onlyScans = (await api().get(`/orgs/${owner.organizationId}/history?kind=scan`).set(as(owner))).body;
    assert.ok(onlyScans.entries.every((entry: { kind: string }) => entry.kind === "scan"));

    // Búsqueda por nombre de proyecto.
    const found = (await api().get(`/orgs/${owner.organizationId}/history?search=Tienda`).set(as(owner))).body;
    assert.ok(found.total >= 1);
    const none = (await api().get(`/orgs/${owner.organizationId}/history?search=zzzznada`).set(as(owner))).body;
    assert.equal(none.total, 0);
  });
});
