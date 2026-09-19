/**
 * Las rutas de flujos, peticiones guardadas, datos y suites por HTTP: los permisos del guard, las
 * rutas de edición y borrado que el resto de pruebas no recorre, y los Problem Details de sus
 * rechazos.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { createTestApp, type TestContext } from "../support/test-app";

let context: TestContext;
const api = () => request(context.app.getHttpServer());

type Actor = { userId: string; organizationId: string; token: string };
async function signUp(email: string): Promise<Actor> {
  const password = "Una-contraseña-larga-1";
  const registered = await api().post("/auth/register").send({ email, password, name: email.split("@")[0] });
  const session = await api().post("/auth/login").send({ email, password });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  return { userId: registered.body.userId, organizationId: registered.body.organizationId, token: session.body.accessToken };
}
const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });

let owner: Actor;
let viewer: Actor;
let outsider: Actor;
let base: string;

before(async () => {
  context = await createTestApp();
  owner = await signUp("wf-owner@example.com");
  viewer = await signUp("wf-viewer@example.com");
  outsider = await signUp("wf-outsider@example.com");
  await context.repositories.memberships.save({
    organizationId: owner.organizationId,
    userId: viewer.userId,
    role: "viewer",
    createdAt: new Date(),
  });
  const project = await api().post(`/orgs/${owner.organizationId}/projects`).set(as(owner)).send({ name: "wf-cov" });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  base = `/orgs/${owner.organizationId}/projects/${project.body.projectId}`;
});
after(async () => {
  await context?.close();
});

const problemType = (body: { type?: string }) => body.type?.split("/").at(-1);

async function createTemplate(name: string) {
  const response = await api()
    .post(`${base}/request-templates`)
    .set(as(owner))
    .send({ name, operationId: "listThings", expectedStatus: 200 });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.requestTemplateId as string;
}

async function createWorkflow(name: string, templateId?: string) {
  const response = await api()
    .post(`${base}/workflows`)
    .set(as(owner))
    .send({ name, ...(templateId ? { definition: { steps: [{ id: "s", requestTemplateId: templateId }] } } : {}) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.workflowId as string;
}

describe("permisos", () => {
  test("a viewer reads the lists but cannot write; an outsider does not even see the project", async () => {
    const listed = await api().get(`${base}/workflows`).set(as(viewer));
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.body).sort(), ["datasets", "requestTemplates", "suites", "workflows"]);

    const write = await api().post(`${base}/request-templates`).set(as(viewer)).send({ name: "x" });
    assert.equal(write.status, 403);
    assert.equal(write.headers["content-type"]?.split(";")[0], "application/problem+json");
    assert.equal((await api().put(`${base}/datasets/any`).set(as(viewer)).send({})).status, 403);
    assert.equal((await api().delete(`${base}/suites/any`).set(as(viewer))).status, 403);

    const foreign = await api().get(`${base}/workflows`).set(as(outsider));
    assert.ok([403, 404].includes(foreign.status), String(foreign.status));
  });

  test("a service token writes as editor and is recorded as the author", async () => {
    const created = await api().post(`/orgs/${owner.organizationId}/tokens`).set(as(owner)).send({ name: "CI wf" });
    assert.equal(created.status, 201);
    const response = await api()
      .post(`${base}/request-templates`)
      .set({ Authorization: `Bearer ${created.body.token}` })
      .send({ name: "Desde CI", operationId: "listThings", expectedStatus: 200 });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const projectId = base.split("/").at(-1)!;
    const saved = await context.repositories.workflows.findTemplate(projectId, response.body.requestTemplateId);
    assert.equal(saved?.updatedBy, created.body.id);
  });
});

describe("peticiones guardadas", () => {
  test("PATCH edits the fields it names, in place", async () => {
    const id = await createTemplate("Editar");
    const patched = await api()
      .patch(`${base}/request-templates/${id}`)
      .set(as(owner))
      .send({ name: "Editada", description: "algo", expectedStatus: 204, headers: { "X-A": "1" } });
    assert.equal(patched.status, 204, JSON.stringify(patched.body));
    const listed = await api().get(`${base}/workflows`).set(as(owner));
    const view = listed.body.requestTemplates.find((row: { id: string }) => row.id === id);
    assert.equal(view.name, "Editada");
    assert.equal(view.description, "algo");
    assert.equal(view.expectedStatus, 204);
    assert.deepEqual(view.headers, { "X-A": "1" });
  });

  test("PATCH of an unknown id is a 404, a clash a 409, a bad shape or a contradiction a 422", async () => {
    const id = await createTemplate("Una");
    await createTemplate("Dos");

    const missing = await api().patch(`${base}/request-templates/no-existe`).set(as(owner)).send({ name: "x" });
    assert.equal(missing.status, 404);
    assert.equal(problemType(missing.body), "request-template-not-found");

    const clash = await api().patch(`${base}/request-templates/${id}`).set(as(owner)).send({ name: "Dos" });
    assert.equal(clash.status, 409);
    assert.equal(problemType(clash.body), "request-template-name-taken");

    const shape = await api().patch(`${base}/request-templates/${id}`).set(as(owner)).send({ expectedStatus: 42 });
    assert.equal(shape.status, 422);
    assert.ok(Array.isArray(shape.body.errors));

    const both = await api()
      .patch(`${base}/request-templates/${id}`)
      .set(as(owner))
      .send({ parameters: { id: "1" }, disabledParameters: { id: "2" } });
    assert.equal(both.status, 422);
    assert.deepEqual(both.body.errors, [{ field: "parameters", detail: "id" }]);
  });

  test("DELETE of a template a flow uses is a 409; once unused it goes", async () => {
    const id = await createTemplate("Usada");
    const workflowId = await createWorkflow("Usa la prueba", id);
    const refused = await api().delete(`${base}/request-templates/${id}`).set(as(owner));
    assert.equal(refused.status, 409);
    assert.equal(problemType(refused.body), "request-template-in-use");
    assert.equal((await api().delete(`${base}/workflows/${workflowId}`).set(as(owner))).status, 204);
    assert.equal((await api().delete(`${base}/request-templates/${id}`).set(as(owner))).status, 204);
    assert.equal((await api().delete(`${base}/request-templates/${id}`).set(as(owner))).status, 404);
  });
});

describe("flujos", () => {
  test("PUT renames, 409 on a taken name, 404 on an unknown flow; duplicate makes a draft copy", async () => {
    const first = await createWorkflow("Primero");
    await createWorkflow("Segundo");
    assert.equal(
      (await api().put(`${base}/workflows/${first}`).set(as(owner)).send({ name: "Primero bis", status: "ready" })).status,
      204,
    );
    const clash = await api().put(`${base}/workflows/${first}`).set(as(owner)).send({ name: "Segundo" });
    assert.equal(clash.status, 409);
    assert.equal(problemType(clash.body), "workflow-name-taken");
    const missing = await api().put(`${base}/workflows/nope`).set(as(owner)).send({ name: "x" });
    assert.equal(missing.status, 404);
    assert.equal(problemType(missing.body), "workflow-not-found");

    const copy = await api().post(`${base}/workflows/${first}/duplicate`).set(as(owner));
    assert.equal(copy.status, 201);
    const listed = await api().get(`${base}/workflows`).set(as(owner));
    const view = listed.body.workflows.find((row: { id: string }) => row.id === copy.body.workflowId);
    assert.equal(view.name, "Primero bis (copia)");
    assert.equal(view.status, "draft");
  });

  test("a bad status is a 422 from the validation pipe", async () => {
    const response = await api().post(`${base}/workflows`).set(as(owner)).send({ name: "x", status: "nope" });
    assert.equal(response.status, 422);
  });
});

describe("datos y suites", () => {
  test("a dataset is created, read with its rows, replaced, renamed, and deleted", async () => {
    const workflowId = await createWorkflow("Con datos");
    const created = await api()
      .post(`${base}/workflows/${workflowId}/datasets`)
      .set(as(owner))
      .send({ name: "filas", rows: [{ a: "1" }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.datasetId as string;

    const replaced = await api()
      .put(`${base}/datasets/${id}`)
      .set(as(owner))
      .send({ name: "filas nuevas", rows: [{ b: "2" }, { b: "3" }] });
    assert.equal(replaced.status, 204, JSON.stringify(replaced.body));
    const read = await api().get(`${base}/datasets/${id}`).set(as(viewer));
    assert.deepEqual(read.body, { id, name: "filas nuevas", rows: [{ b: "2" }, { b: "3" }] });

    const listed = await api().get(`${base}/workflows`).set(as(owner));
    const view = listed.body.datasets.find((row: { id: string }) => row.id === id);
    assert.deepEqual({ columns: view.columns, rowCount: view.rowCount }, { columns: ["b"], rowCount: 2 });

    const badRows = await api().put(`${base}/datasets/${id}`).set(as(owner)).send({ rows: [{ "no vale": "1" }] });
    assert.equal(badRows.status, 422);
    assert.equal(problemType(badRows.body), "dataset-invalid");

    assert.equal((await api().delete(`${base}/datasets/${id}`).set(as(owner))).status, 204);
    const gone = await api().get(`${base}/datasets/${id}`).set(as(owner));
    assert.equal(gone.status, 404);
    assert.equal(problemType(gone.body), "dataset-not-found");
    assert.equal((await api().delete(`${base}/datasets/${id}`).set(as(owner))).status, 404);
    assert.equal((await api().put(`${base}/datasets/${id}`).set(as(owner)).send({ name: "x" })).status, 404);
  });

  test("a suite is updated and deleted; a taken name is a 409 and an unknown suite a 404", async () => {
    const one = await createWorkflow("Suite uno");
    const two = await createWorkflow("Suite dos");
    const suite = await api().post(`${base}/suites`).set(as(owner)).send({ name: "Entrega", workflowIds: [one] });
    assert.equal(suite.status, 201);
    await api().post(`${base}/suites`).set(as(owner)).send({ name: "Otra" });

    assert.equal(
      (
        await api()
          .put(`${base}/suites/${suite.body.suiteId}`)
          .set(as(owner))
          .send({ workflowIds: [two, one], description: "orden" })
      ).status,
      204,
    );
    const listed = await api().get(`${base}/workflows`).set(as(owner));
    const view = listed.body.suites.find((row: { id: string }) => row.id === suite.body.suiteId);
    assert.deepEqual(view.workflowIds, [two, one]);
    assert.equal(view.description, "orden");

    const clash = await api().put(`${base}/suites/${suite.body.suiteId}`).set(as(owner)).send({ name: "Otra" });
    assert.equal(clash.status, 409);
    assert.equal(problemType(clash.body), "suite-name-taken");

    assert.equal((await api().delete(`${base}/suites/${suite.body.suiteId}`).set(as(owner))).status, 204);
    const missing = await api().delete(`${base}/suites/${suite.body.suiteId}`).set(as(owner));
    assert.equal(missing.status, 404);
    assert.equal(problemType(missing.body), "suite-not-found");
  });
});
