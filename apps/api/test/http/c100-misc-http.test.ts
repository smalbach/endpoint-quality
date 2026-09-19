/**
 * Por HTTP, lo que las pruebas de cada módulo no pasan: un token de API como autor de una captura,
 * una sección de configuración, una documentación, un mock y un monitor; el cursor de la captura
 * que falta o no es un número; la cobertura y la matriz sin contrato, con la versión perdida o con
 * un entorno ajeno; la bitácora de un mock que no existe; y la documentación publicada de un
 * proyecto borrado o con un endpoint sin ejemplos.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

type Actor = { organizationId: string; token: string };
async function signUp(tag: string): Promise<Actor> {
  const email = `c100-misc-${tag}-${Date.now()}@example.test`;
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: "x" });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200);
  return { organizationId: registered.body.organizationId, token: session.body.accessToken };
}

let owner: Actor;
let apiToken: string;
let apiTokenId: string;

async function newProject(actor: Actor, name: string): Promise<string> {
  const created = await api().post(`/orgs/${actor.organizationId}/projects`).set(as(actor.token)).send({ name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.projectId;
}

before(async () => {
  context = await createTestApp();
  owner = await signUp("owner");
  const issued = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner.token)).send({ name: "CI" });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  apiToken = issued.body.token;
  apiTokenId = issued.body.id;
});

after(async () => {
  await context?.close();
});

describe("un token de API como autor", () => {
  test("de una captura, y la página sin cursor o con uno que no es un número empieza por el principio", async () => {
    const projectId = await newProject(owner, "Capturas por token");
    const base = `/orgs/${owner.organizationId}/projects/${projectId}/captures`;
    const started = await api().post(base).set(as(apiToken)).send({});
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const sessionId: string = started.body.session.id;
    assert.equal(context.repositories.captures.sessions.get(sessionId)!.startedBy, apiTokenId);

    for (const query of ["", "?after=nada"]) {
      const page = await api().get(`${base}/${sessionId}${query}`).set(as(owner.token));
      assert.equal(page.status, 200, query);
      assert.equal(page.body.session.id, sessionId);
      assert.deepEqual(page.body.items, []);
    }
    await api().post(`${base}/${sessionId}/stop`).set(as(owner.token)).expect(200);
  });

  test("de una sección de configuración", async () => {
    const projectId = await newProject(owner, "Configuración por token");
    const saved = await api()
      .put(`/orgs/${owner.organizationId}/projects/${projectId}/config/budgets`)
      .set(as(apiToken))
      .send({ budgets: [] });
    assert.equal(saved.status, 204, JSON.stringify(saved.body));
    const row = [...context.repositories.config.rows.values()].find((entry) => entry.projectId === projectId)!;
    assert.equal(row.updatedBy, apiTokenId);
  });

  test("de una documentación, un mock y un monitor", async () => {
    const projectId = await newProject(owner, "Todo por token");
    const base = `/orgs/${owner.organizationId}/projects/${projectId}`;

    const site = await api().post(`${base}/doc-sites`).set(as(apiToken)).send({ name: "api", visibility: "public" });
    assert.equal(site.status, 201, JSON.stringify(site.body));
    assert.equal(context.repositories.docSites.rows.get(site.body.site.id)!.createdBy, apiTokenId);

    const mock = await api().post(`${base}/mocks`).set(as(apiToken)).send({ name: "mock", visibility: "public" });
    assert.equal(mock.status, 201, JSON.stringify(mock.body));
    assert.equal(context.repositories.mocks.rows.get(mock.body.mock.id)!.createdBy, apiTokenId);

    const environment = await api()
      .post(`${base}/environments`)
      .set(as(owner.token))
      .send({ name: "prod", baseUrl: "https://api.example.test" });
    assert.equal(environment.status, 201, JSON.stringify(environment.body));
    const monitor = await api()
      .post(`${base}/monitors`)
      .set(as(apiToken))
      .send({
        name: "vigía",
        schedule: { kind: "interval", minutes: 60 },
        plan: { environmentId: environment.body.environmentId },
      });
    assert.equal(monitor.status, 201, JSON.stringify(monitor.body));
    assert.equal(context.repositories.monitors.rows.get(monitor.body.id)!.createdBy, apiTokenId);
  });
});

describe("cobertura y matriz, por sus 404 y 409", () => {
  test("sin contrato importado la cobertura es un 409", async () => {
    const projectId = await newProject(owner, "Sin contrato");
    const answer = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/coverage`).set(as(owner.token));
    assert.equal(answer.status, 409);
    assert.match(answer.body.type, /no-active-spec$/);
  });

  test("un proyecto de otra organización no existe para la cobertura ni para la matriz", async () => {
    const other = await signUp("other");
    const foreign = await newProject(other, "Ajeno");
    for (const path of ["coverage", "scenarios"]) {
      const answer = await api().get(`/orgs/${owner.organizationId}/projects/${foreign}/${path}`).set(as(owner.token));
      assert.equal(answer.status, 404, path);
      assert.match(answer.body.type, /project-not-found$/, path);
    }
  });

  test("una versión activa que ya no está es un 404 en las dos", async () => {
    const projectId = await newProject(owner, "Versión perdida");
    const project = context.repositories.projects.rows.get(projectId)!;
    context.repositories.projects.rows.set(projectId, { ...project, activeSpecVersionId: randomUUID() });
    for (const path of ["coverage", "scenarios"]) {
      const answer = await api().get(`/orgs/${owner.organizationId}/projects/${projectId}/${path}`).set(as(owner.token));
      assert.equal(answer.status, 404, path);
      assert.match(answer.body.type, /spec-version-not-found$/, path);
    }
  });

  test("la matriz con un entorno que no existe o que es de otro proyecto es un 404", async () => {
    const projectId = await newProject(owner, "Con contrato");
    const otherProject = await newProject(owner, "Otro con entorno");
    const specVersionId = randomUUID();
    await context.repositories.specs.saveVersion(
      {
        id: specVersionId,
        projectId,
        sourceId: null,
        hash: "h",
        raw: "{}",
        format: "json",
        openapiVersion: "3.0.0",
        title: "t",
        contractVersion: "1.0.0",
        operationCount: 0,
        problems: [],
        importedBy: "u",
        importedAt: new Date(),
      },
      [],
    );
    const project = context.repositories.projects.rows.get(projectId)!;
    context.repositories.projects.rows.set(projectId, { ...project, activeSpecVersionId: specVersionId });
    const foreignEnv = await api()
      .post(`/orgs/${owner.organizationId}/projects/${otherProject}/environments`)
      .set(as(owner.token))
      .send({ name: "ajeno", baseUrl: "https://api.example.test" });
    assert.equal(foreignEnv.status, 201, JSON.stringify(foreignEnv.body));

    const base = `/orgs/${owner.organizationId}/projects/${projectId}/scenarios`;
    const fine = await api().get(base).set(as(owner.token));
    assert.equal(fine.status, 200, JSON.stringify(fine.body));
    for (const environmentId of [randomUUID(), foreignEnv.body.environmentId]) {
      const answer = await api().get(`${base}?environmentId=${environmentId}`).set(as(owner.token));
      assert.equal(answer.status, 404);
      assert.match(answer.body.type, /environment-not-found$/);
    }
  });
});

describe("mocks y documentación publicada", () => {
  test("la bitácora de un mock que no existe es un 404", async () => {
    const projectId = await newProject(owner, "Sin mock");
    const answer = await api()
      .get(`/orgs/${owner.organizationId}/projects/${projectId}/mocks/${randomUUID()}/calls`)
      .set(as(owner.token));
    assert.equal(answer.status, 404);
    assert.match(answer.body.type, /mock-not-found$/);
  });

  test("con ejemplos, un endpoint sin ninguno sale con la lista vacía; con el proyecto borrado, un 404", async () => {
    const projectId = await newProject(owner, "Docs");
    const base = `/orgs/${owner.organizationId}/projects/${projectId}`;
    const endpoint = await api().post(`${base}/endpoints`).set(as(owner.token)).send({ method: "GET", path: "/v1/salud" });
    assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
    const site = await api()
      .post(`${base}/doc-sites`)
      .set(as(owner.token))
      .send({ name: "pública", visibility: "public", includeExamples: true });
    assert.equal(site.status, 201, JSON.stringify(site.body));
    const publicId: string = site.body.site.publicId;

    const page = await api().get(`/shared/docs/${publicId}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const documented = page.body.groups.flatMap((group: { endpoints: unknown[] }) => group.endpoints) as {
      path: string;
      examples: unknown[];
    }[];
    assert.deepEqual(
      documented.map((entry) => [entry.path, entry.examples]),
      [["/v1/salud", []]],
    );

    const project = context.repositories.projects.rows.get(projectId)!;
    context.repositories.projects.rows.set(projectId, { ...project, deletedAt: new Date() });
    const gone = await api().get(`/shared/docs/${publicId}`);
    assert.equal(gone.status, 404);
    assert.match(gone.body.type, /doc-site-not-found$/);
  });
});
